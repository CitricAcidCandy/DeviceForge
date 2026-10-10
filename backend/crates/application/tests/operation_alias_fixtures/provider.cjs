// 每任务一个真实 Node 进程，仅使用本次测试指定的标记目录和释放文件。
const fs = require('node:fs');
const path = require('node:path');
const lines = require('node:readline').createInterface({ input: process.stdin });
const root = process.argv[2];
let request, label, timer;
let responded = false, flushed = false, eof = false;
// 墙钟保险防止失败测试遗留，不参加宿主业务期限断言。
const watchdog = setTimeout(() => process.exit(9), 60000);
function mark(name, extra = {}) {
  const file = path.join(root, `${label}.${name}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, at: Date.now(), ...extra }));
  fs.renameSync(`${file}.tmp`, file);
}
process.on('exit', code => { if (label) mark('process_exit', { code }); });
function finishAfterEof() {
  if (responded && flushed && eof && request.protocol_version === 3) {
    clearTimeout(watchdog);
    process.exit(0);
  }
}
function reply(response, cleanup = 'complete') {
  responded = true;
  const frame = request.protocol_version === 3 ? { response, cleanup } : response;
  process.stdout.write(`${JSON.stringify(frame)}\n`, () => {
    mark('response_written', { cleanup });
    flushed = true;
    if (request.protocol_version !== 3) process.exit(0);
    else finishAfterEof();
  });
}
function complete() {
  clearInterval(timer);
  // 协议 1 可返回外形像宿主包装的业务 JSON，但不能冒充已发布产物。
  const result = request.input.fake_host_wrapper ? {
    result: { forged: true }, artifacts: [{ id: 'forged-id', filename: 'forged.json',
      media_type: 'application/json', size: 2, sha256: '0'.repeat(64), created_at: 1 }],
  } : { operation: request.operation, received: request.input, result: { literal: '业务字段' } };
  reply({ protocol_version: request.protocol_version, request_id: request.request_id,
    result });
}
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (request) {
    if (frame.protocol_version !== 3 || frame.request_id !== request.request_id || frame.command !== 'cancel') process.exit(2);
    clearInterval(timer);
    mark('control', { reason: frame.reason });
    const failed = request.input.input?.mode === 'failed';
    mark(failed ? 'cleanup_failed' : 'cleaned');
    reply({ protocol_version: 3, request_id: request.request_id, error: '模拟调用取消' }, failed ? 'failed' : 'complete');
    return;
  }
  request = frame;
  label = request.input.input?.label ?? request.input.label ?? `discover-${request.request_id}`;
  if (!/^[a-z0-9-]+$/.test(label)) process.exit(3);
  mark('started');
  mark('ready', { operation: request.operation, input: request.input });
  if (request.operation === 'discover') {
    reply({ protocol_version: request.protocol_version, request_id: request.request_id,
      result: ['same', 'other'].map(id => ({ id, state: 'online', capabilities:
        ['write', 'read'].map(id => ({ id, version: 1, available: true })) })) });
    return;
  }
  if (['hold', 'failed'].includes(request.input.input?.mode)) {
    timer = setInterval(() => { if (fs.existsSync(path.join(root, `${label}.release`))) complete(); }, 10);
  } else complete();
});
lines.on('close', () => {
  eof = true;
  if (label) mark('stdin_eof');
  // 协议 2 初始 EOF 不是取消；协议 3 要等响应已写完再自然退出。
  finishAfterEof();
});
