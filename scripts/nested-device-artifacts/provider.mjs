import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import config from './config.mjs';

// 此入口随 TGZ 独立执行；配置路径仅由本次测试管理员生成。
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let request;
let label;
let cancelled = false;
let replyStarted = false;
let notifyCancel;
const cancellation = new Promise((done) => {
  notifyCancel = done;
});
const record = (kind, extra = {}) =>
  appendFileSync(
    join(config.directory, 'events.jsonl'),
    `${JSON.stringify({
      kind,
      at: Date.now(),
      pid: process.pid,
      provider_id: config.id,
      request_id: request.request_id,
      operation: request.operation,
      label,
      ...extra,
    })}\n`,
    'utf8',
  );

function cancel(controlFrame) {
  if (!request || replyStarted || cancelled) return;
  cancelled = true;
  record(controlFrame ? 'cancel_received' : 'stdin_closed_early');
  notifyCancel();
}

async function blocked() {
  let timer;
  try {
    await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('夹具未在设备 30 秒期限内收到预期取消')), 28000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function execute() {
  assert.equal(request.protocol_version, config.protocol);
  assert.equal(typeof request.request_id, 'string');
  assert.equal(Boolean(process.env.APK_API_TOKEN), false);
  const discovery = request.operation === 'discover';
  label = discovery ? `discover-${request.request_id}` : request.input.input.label;
  assert.match(label, /^[a-z0-9_-]{1,80}$/);
  record('started');
  let result;
  let outputs = [];
  assert.ok(request.artifacts);
  if (discovery) {
    assert.deepEqual(request.input, {});
    assert.deepEqual(request.artifacts.inputs, []);
    // 发现不读取任何产物文件；入口及配置由 Node 模块加载。
    record('discovered_without_artifact_read', { input_count: 0 });
    result = [
      {
        id: config.localId,
        state: 'online',
        model: 'synthetic_demo',
        capabilities: [
          { id: 'device.write', version: 1, available: true },
          { id: 'device.write_unchecked', version: 1, available: true },
        ],
      },
    ];
  } else {
    assert.ok(['write', 'write_unchecked'].includes(request.operation));
    assert.equal(request.input.device_id, config.localId);
    assert.equal(request.artifacts.inputs.length, 1, '未声明 ID 不得进入上下文');
    const reference = request.artifacts.inputs[0];
    assert.equal(reference.field, '/input/artifact_id');
    assert.equal(reference.artifact_id, request.input.input.artifact_id);
    assert.equal(reference.sha256, config.source_sha256);
    assert.equal(reference.size, config.source_size);
    assert.ok(isAbsolute(reference.path));
    assert.ok(statSync(reference.path).isFile());
    const bytes = readFileSync(reference.path);
    assert.equal(bytes.length, reference.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
    JSON.parse(bytes.toString('utf8'));
    record('copy_verified', { field: reference.field, input_count: 1, sha256: reference.sha256 });
    if (request.input.input.mode === 'blocked') await blocked();
    if (!cancelled) {
      assert.ok(isAbsolute(request.artifacts.output_directory));
      writeFileSync(join(request.artifacts.output_directory, 'device-result.json'), bytes);
      // 修改本次副本，再由客户端下载原产物证明持久化原字节未被修改。
      writeFileSync(reference.path, '{"仅修改本次副本":true}\n', 'utf8');
      outputs = [{ filename: 'device-result.json' }];
      result = {
        synthetic_demo: true,
        provider_id: config.id,
        device_id: config.localId,
        source_artifact_id: reference.artifact_id,
        field: reference.field,
        input_sha256: reference.sha256,
        input_size: reference.size,
        input_count: 1,
        undeclared_exposed: false,
      };
      record('output_written');
    }
  }
  // 标记只证明夹具计时器已停止；副本/输出目录属于宿主，不能冒充真机资源清理。
  record('cleaned');
  const response = {
    protocol_version: config.protocol,
    request_id: request.request_id,
    ...(cancelled ? { error: '模拟调用已合作取消' } : { result, outputs }),
  };
  replyStarted = true;
  const frame = config.protocol === 3 ? { response, cleanup: 'complete' } : response;
  await new Promise((done, reject) =>
    process.stdout.write(`${JSON.stringify(frame)}\n`, (error) => (error ? reject(error) : done())),
  );
  record('response_written');
  // 协议 3 保持输入流，等待宿主在匹配响应后关闭；协议 2 由宿主预先关闭输入。
}

lines.on('line', (line) => {
  try {
    const frame = JSON.parse(line);
    if (!request) {
      request = frame;
      execute().catch(() => {
        if (label) record('fixture_error');
        process.stderr.write('嵌套产物夹具执行失败\n');
        process.exitCode = 1;
        lines.close();
        process.stdin.destroy();
      });
    } else {
      assert.equal(config.protocol, 3);
      assert.equal(frame.protocol_version, 3);
      assert.equal(frame.request_id, request.request_id);
      assert.equal(frame.command, 'cancel');
      cancel(true);
    }
  } catch {
    process.stderr.write('嵌套产物夹具控制帧无效\n');
    process.exitCode = 1;
    cancel(false);
    lines.close();
    process.stdin.destroy();
  }
});
process.stdin.on('end', () => {
  if (request && label) record('stdin_eof');
});
lines.on('close', () => {
  if (request && label) record('readline_closed');
  if (config.protocol === 3) cancel(false);
});
process.on('exit', (code) => {
  if (request && label) record('process_exit', { code });
});
