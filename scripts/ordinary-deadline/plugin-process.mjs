import {
  appendFileSync, closeSync, existsSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 配置由本次可信 TGZ 固定；SDK input 只能选择有限 case_id。
const config = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
if (![2, 3].includes(config.protocolVersion) || !isAbsolute(config.controlRoot)
  || typeof config.pluginId !== 'string' || typeof config.runId !== 'string') {
  throw new Error('普通期限夹具固定配置无效');
}
const requestLimit = 512 * 1024;
const controlLimit = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });
let request;
let identity;
let paths;
let readyNs;
let completedNs;
let resourceFd;
let resourceOwned = false;
let resourceCleaned = false;
let cancelled = false;
let cancelReason;
let responseStarted = false;
let responseWritten = false;
let stdinEnded = false;
let failed = false;
let failureCode;
let outcome = 'running';
let pending = Buffer.alloc(0);
let resolveEof;
const eof = new Promise((resolve) => { resolveEof = resolve; });

function record(event, extra = {}) {
  if (!identity) return;
  appendFileSync(paths.events, `${JSON.stringify({
    ...identity, event, monotonic_ns: process.hrtime.bigint().toString(), ...extra,
  })}\n`, 'utf8');
}

function atomicJson(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, target);
}

function cleanResource() {
  if (!resourceOwned) return;
  if (resourceFd !== undefined) {
    closeSync(resourceFd);
    resourceFd = undefined;
  }
  // 只释放本进程以 wx 创建的单个夹具文件；不递归删除控制目录或其它案例。
  unlinkSync(paths.resource);
  resourceOwned = false;
  resourceCleaned = true;
  record('cleaned');
}

function fail(code) {
  if (failed) return;
  failed = true;
  outcome = 'fixture_failed';
  failureCode = code;
  clearTimeout(watchdog);
  try { cleanResource(); } catch { /* 失败证据保留当前实际释放状态，不伪造清理成功。 */ }
  process.stderr.write('普通期限夹具失败，详见本次诊断标记\n');
  process.exit(1);
}

function objectWithKeys(value, required, allowed = required) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.includes(key));
}

function validCaseId(value) {
  // 避免 JS 的 $ 在末尾换行前匹配；实际输入须逐字符属于 ASCII 白名单。
  return typeof value === 'string' && value.length >= 1 && value.length <= 80
    && !/[^A-Za-z0-9_-]/.test(value);
}

function validateRequest(frame) {
  if (!objectWithKeys(frame, ['protocol_version', 'request_id', 'operation', 'input'],
    ['protocol_version', 'request_id', 'operation', 'input', 'artifacts'])
    || frame.protocol_version !== config.protocolVersion
    || typeof frame.request_id !== 'string' || !frame.request_id
    || Buffer.byteLength(frame.request_id, 'utf8') > 128
    || /[\u0000-\u001f\u007f]/.test(frame.request_id)
    || !['long', 'short', 'default'].includes(frame.operation)
    || !objectWithKeys(frame.input, ['case_id']) || !validCaseId(frame.input.case_id)) {
    throw new Error('SDK 请求或普通期限输入无效');
  }
  // 宿主协议 2/3 可附带空标准产物上下文；本夹具不读输入产物也不发布文件输出。
  if (frame.artifacts != null && (!objectWithKeys(frame.artifacts, ['inputs', 'output_directory'])
    || !Array.isArray(frame.artifacts.inputs) || frame.artifacts.inputs.length !== 0
    || frame.artifacts.output_directory !== null)) {
    throw new Error('普通期限夹具不接受额外产物权限');
  }
}

function prepareCase() {
  const base = join(config.controlRoot, request.input.case_id);
  const candidates = {
    ready: `${base}.ready.json`, release: `${base}.release`, events: `${base}.events.jsonl`,
    resource: `${base}.resource`, diagnostic: `${base}.diagnostic.json`,
  };
  if (Object.values(candidates).some((file) => existsSync(file))) {
    throw new Error('case_id 已存在，禁止借用旧标记');
  }
  // 先取得本次文件所有权，才建立身份和发布 ready；重复案例不能污染旧事件。
  resourceFd = openSync(candidates.resource, 'wx');
  resourceOwned = true;
  paths = candidates;
  readyNs = process.hrtime.bigint();
  identity = {
    run_id: config.runId, case_id: request.input.case_id, plugin_id: config.pluginId,
    protocol_version: config.protocolVersion, pid: process.pid,
    request_id: request.request_id, request_operation: request.operation,
    ready_monotonic_ns: readyNs.toString(),
  };
  writeSync(resourceFd, '本次受控夹具资源\n');
  atomicJson(paths.ready, identity);
  record('ready');
}

function receiveCancel(frame) {
  if (config.protocolVersion !== 3
    || !objectWithKeys(frame, ['protocol_version', 'request_id', 'command', 'reason'])
    || frame.protocol_version !== 3 || frame.request_id !== request.request_id
    || frame.command !== 'cancel' || !['timeout', 'cancelled'].includes(frame.reason)
    || cancelReason !== undefined) {
    throw new Error('收到不匹配或重复的合作取消帧');
  }
  cancelReason = frame.reason;
  record('cancel_received', {
    reason: frame.reason, command: frame.command,
    control_request_id: frame.request_id, id_matches: frame.request_id === request.request_id,
  });
  // 已开始发送的成功帧不重写为另一帧；迟到控制仍保留原值供宿主资格门禁复核。
  if (!responseStarted) cancelled = true;
}

async function waitForWork() {
  if (request.operation === 'default') return process.hrtime.bigint();
  while (!cancelled) {
    try {
      if (readFileSync(paths.release, 'utf8') === '1') return process.hrtime.bigint();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // release 写入期间的空文件不放行；只有完整 UTF-8 内容 1 才结束 hold。
    await delay(25);
  }
  return undefined;
}

async function waitForEof() {
  if (stdinEnded) return;
  let timer;
  try {
    await Promise.race([eof, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('响应后未收到真实 stdin EOF')), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function execute() {
  // 所有 stdin/exit/异常处理器均先安装，再进入此函数发布 ready。
  prepareCase();
  completedNs = await waitForWork();
  cleanResource();
  const response = {
    protocol_version: config.protocolVersion,
    request_id: request.request_id,
    ...(cancelled ? { error: '普通期限夹具已收到取消并完成受控资源清理' } : {
      result: {
        ...identity,
        completed_monotonic_ns: completedNs.toString(),
        elapsed_ms: Number(completedNs - readyNs) / 1_000_000,
      },
    }),
  };
  // 协议 2 是 SDK Response；协议 3 只增加 SDK 已定义的 CooperativeResponse。
  const frame = config.protocolVersion === 3 ? { response, cleanup: 'complete' } : response;
  responseStarted = true;
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
  });
  responseWritten = true;
  record('response_written');
  await waitForEof();
  outcome = cancelled ? 'cancelled' : 'succeeded';
  clearTimeout(watchdog);
  process.exitCode = 0;
}

function receiveLine(bytes) {
  const frame = JSON.parse(decoder.decode(bytes));
  if (request === undefined) {
    validateRequest(frame);
    request = frame;
    execute().catch(() => fail('execution_failed'));
  } else {
    receiveCancel(frame);
  }
}

function receiveBytes(chunk) {
  let remaining = chunk;
  while (remaining.length > 0 && !failed) {
    const newline = remaining.indexOf(10);
    const piece = newline < 0 ? remaining : remaining.subarray(0, newline);
    const limit = request === undefined ? requestLimit : controlLimit;
    if (pending.length + piece.length > limit) throw new Error('SDK 输入帧超限');
    pending = Buffer.concat([pending, piece]);
    if (newline < 0) return;
    const line = pending;
    pending = Buffer.alloc(0);
    receiveLine(line);
    remaining = remaining.subarray(newline + 1);
  }
}

// 130 秒仅是夹具的孤儿兜底，晚于 long 声明；short 到期必须由宿主触发。
const watchdog = setTimeout(() => fail('fixture_watchdog_elapsed'), 130000);

process.on('exit', (code) => {
  if (!identity) return;
  try {
    record('process_exit', { code });
    atomicJson(paths.diagnostic, {
      ...identity,
      outcome,
      failure_code: failureCode ?? null,
      cancel_reason: cancelReason ?? null,
      response_started: responseStarted,
      response_written: responseWritten,
      stdin_eof: stdinEnded,
      controlled_resource_released: resourceCleaned,
      completed_monotonic_ns: completedNs?.toString() ?? null,
      exit_callback_code: code,
      monotonic_ns: process.hrtime.bigint().toString(),
    });
  } catch {
    // 证据写入失败不能仍让宿主把本次进程记成正常零退出。
    process.exitCode = 1;
  }
});

process.on('uncaughtException', () => fail('uncaught_exception'));
process.on('unhandledRejection', () => fail('unhandled_rejection'));
process.stdout.on('error', () => fail('stdout_io_failed'));
process.stdin.on('error', () => fail('stdin_io_failed'));

process.stdin.on('end', () => {
  try {
    // 兼容协议 2 的有限 JSON+EOF；当前宿主两协议都会附加换行。
    if (pending.length > 0) {
      const tail = pending;
      pending = Buffer.alloc(0);
      receiveLine(tail);
    }
    stdinEnded = true;
    record('stdin_eof');
    resolveEof();
    if (request === undefined) throw new Error('EOF 前没有合法 SDK 请求');
    // EOF 不是取消帧。协议 2 正常断流后继续 hold；协议 3 预先断流保留失败。
    if (config.protocolVersion === 3 && !responseStarted && !cancelled) {
      throw new Error('合作协议在响应或合法取消前收到 EOF');
    }
  } catch {
    fail('invalid_stdin_eof');
  }
});

process.stdin.on('close', () => {
  if (!stdinEnded && !failed) fail('stdin_closed_without_eof');
});

// data 监听最后注册，确保首个请求发布 ready 前清理和证据处理器已就绪。
process.stdin.on('data', (chunk) => {
  try { receiveBytes(chunk); } catch { fail('invalid_sdk_frame'); }
});
