import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// 自包含 TGZ 的真实进程入口；控制目录只来自测试管理员，不接受业务输入路径。
const config = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let request;
let control;
let sequence = 0;
let cancelled = false;
let replyStarted = false;
let stdinEnded = false;
let running = false;
let resolveEof;
const eof = new Promise((done) => { resolveEof = done; });

function record(kind, extra = {}) {
  if (!request || !control) return;
  const scenario = `${control.mode}/${control.rawCase}/${control.resultMode}/${control.cancelMode}`;
  appendFileSync(join(config.directory, 'events.jsonl'), `${JSON.stringify({
    kind, at: Date.now(), sequence: ++sequence, pid: process.pid, provider_id: config.id,
    request_id: request.request_id, operation: request.operation, label: control.label, scenario,
    protocol: config.protocol, devices_api_version: config.devicesApiVersion, ...extra,
  })}\n`, 'utf8');
}

function fail(error) {
  record('fixture_failed');
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
  cancelled = true;
  lines.close();
  process.stdin.destroy();
}

function receiveCancel(frame) {
  if (config.protocol !== 3 || frame.protocol_version !== 3
    || frame.request_id !== request.request_id || frame.command !== 'cancel') {
    throw new Error('夹具收到不匹配的控制帧');
  }
  record('cancel_received');
  if (!replyStarted && control.cancelMode !== 'ignore') cancelled = true;
}

async function waitForWork() {
  const duration = control.mode === 'hold' ? control.waitLimitMs : control.durationMs;
  const deadline = Date.now() + duration;
  while (!cancelled) {
    if (control.mode === 'hold' && existsSync(join(config.directory, `${control.label}.release`))) {
      record('released');
      return;
    }
    if (Date.now() >= deadline) {
      if (control.mode === 'hold') throw new Error('夹具发现门闩未在有限期限内解除');
      return;
    }
    // 每次只有一个短计时器；收到取消后先结束这个计时器再记录清理。
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

function discovery() {
  const device = { id: config.localId, state: control.state,
    capabilities: [{ id: 'device_read', version: 1, available: true }, { id: 'device_write', version: 1, available: true }] };
  if (Object.hasOwn(control, 'rawState')) device.raw_state = control.rawState;
  if (Object.hasOwn(control, 'model')) device.model = control.model;
  let result = [device];
  if (control.mode === 'empty') result = [];
  if (control.mode === 'duplicate') result = [device, structuredClone(device)];
  if (control.mode === 'bad-state') device.state = '不属于公开枚举';
  if (control.mode === 'undeclared-capability') device.capabilities = [{ id: 'undeclared', version: 1, available: true }];
  if (control.mode === 'mixed-bad-raw') result = [device, { ...structuredClone(device), id: config.otherId, raw_state: 'invalid\u0085state' }];
  // 这里是故意无效的业务 JSON。真实 host wrapper 只能由宿主产物发布层产生。
  if (control.resultMode === 'pseudo-wrapper') result = { result, artifacts: [] };
  if (control.resultMode === 'pseudo-wrapper-extra') result = { result, artifacts: [], invented: true };
  if (control.resultMode === 'object') result = { devices: result };
  return result;
}

async function waitForEof() {
  if (stdinEnded) return;
  let timer;
  try {
    await Promise.race([eof, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('夹具响应后未收到真实 stdin EOF')), control.eofTimeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function execute() {
  if (request.protocol_version !== config.protocol || ![1, 2, 3].includes(request.protocol_version)
    || typeof request.request_id !== 'string' || !request.request_id || process.env.APK_API_TOKEN) {
    throw new Error('夹具要求匹配公开任务协议，且不得继承令牌');
  }
  control = JSON.parse(readFileSync(join(config.directory, 'control.json'), 'utf8'));
  if (!/^[a-z0-9_-]{1,80}$/.test(control.label)) throw new Error('夹具标签必须是受控简单名称');
  const discover = request.operation === 'discover';
  if (discover && (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)
    || Object.keys(request.input).length !== 0)) {
    throw new Error('发现业务输入必须严格为空对象，场景标签只能走管理员控制文件');
  }
  if (!discover && (!['device_read', 'device_write'].includes(request.operation)
    || !request.input || typeof request.input.device_id !== 'string'
    || !request.input.input || typeof request.input.input !== 'object' || Array.isArray(request.input.input))) {
    throw new Error('夹具仅接受已声明的设备能力封套');
  }
  record('started');
  // 协议 3 的预先断流可以早于 execute 首次异步等待；协议 1/2 的正常 EOF 不表示取消。
  if (config.protocol === 3 && stdinEnded) cancelled = true;
  await waitForWork();
  await delay(control.cleanupDelayMs);
  const cleanupFailed = cancelled && control.cancelMode === 'failed';
  record(cleanupFailed ? 'cleanup_failed' : 'cleaned');
  const response = { protocol_version: config.protocol, request_id: request.request_id,
    ...(cancelled ? { error: '夹具已收到取消并结束本次发现' }
      : { result: discover ? discovery() : { device_id: request.input.device_id, operation: request.operation, synthetic_device: true } }) };
  const frame = config.protocol === 3 ? { response, cleanup: cleanupFailed ? 'failed' : 'complete' } : response;
  replyStarted = true;
  await new Promise((done, reject) => process.stdout.write(`${JSON.stringify(frame)}\n`,
    (error) => error ? reject(error) : done()));
  record('response_written');
  // 两协议都等待真实 EOF；协议 2 正常先收到 EOF，协议 3 故意在响应后等宿主断流。
  await waitForEof();
  process.exitCode = control.exitCode;
  running = false;
}

lines.on('line', (line) => {
  try {
    const frame = JSON.parse(line);
    if (!request) {
      request = frame;
      running = true;
      execute().catch(fail);
    } else {
      receiveCancel(frame);
    }
  } catch (error) {
    fail(error);
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  record('stdin_eof');
  resolveEof();
  if (config.protocol === 3 && running && !replyStarted && control?.cancelMode !== 'ignore') {
    record('stdin_disconnected');
    cancelled = true;
  }
});
lines.on('close', () => { record('readline_closed'); });
process.on('exit', (code) => { record('process_exit', { exit_code: code }); });
