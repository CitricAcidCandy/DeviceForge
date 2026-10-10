// 每次调用一个真实 Node 进程，只操作本次宿主副本和管理员指定标记目录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lines = require('node:readline').createInterface({ input: process.stdin });
const root = process.argv[2];
let request;
let responded = false;
let flushed = false;
let eof = false;
let hold;
let responseTimer;

function mark(name, details = {}) {
  const target = path.join(root, `${name}.json`);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify({ pid: process.pid, at: Date.now(), ...details }));
  fs.renameSync(`${target}.tmp`, target);
}

mark('started');
process.on('exit', code => mark('process_exit', { code }));
// 夹具自身的最终保险只限制异常测试遗留，不参与宿主期限断言。
const watchdog = setTimeout(() => process.exit(9), 30000);

function reply(response) {
  responded = true;
  const frame = request.protocol_version === 3
    ? { response, cleanup: 'complete' }
    : response;
  process.stdout.write(`${JSON.stringify(frame)}\n`, () => {
    mark('response_written');
    flushed = true;
    if (request.protocol_version === 2) process.exit(0);
    else finishAfterEof();
  });
}

function finishAfterEof() {
  if (responded && flushed && eof && request.protocol_version === 3) {
    clearTimeout(watchdog);
    process.exit(0);
  }
}

function complete() {
  clearInterval(hold);
  clearTimeout(responseTimer);
  const input = request.artifacts.inputs[0];
  if (input) fs.copyFileSync(input.path, path.join(request.artifacts.output_directory, 'copy.png'));
  reply({
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    result: { device_id: request.input.device_id, copied: Boolean(input) },
    outputs: input ? [{ filename: 'copy.png' }] : [],
  });
}

lines.on('line', line => {
  const frame = JSON.parse(line);
  if (request) {
    if (frame.protocol_version !== 3 || frame.request_id !== request.request_id
      || frame.command !== 'cancel') process.exit(2);
    mark('control', { reason: frame.reason });
    if (request.input.input.mode === 'ignore') return;
    clearInterval(hold);
    clearTimeout(responseTimer);
    mark('cleaned', { reason: frame.reason });
    reply({ protocol_version: 3, request_id: request.request_id, error: '模拟设备取消并清理' });
    return;
  }
  request = frame;
  if (request.operation === 'discover') {
    mark('ready', { work: process.cwd() });
    reply({ protocol_version: request.protocol_version, request_id: request.request_id,
      result: [{ id: 'same', state: 'online', capabilities: [{ id: 'device.copy', version: 1, available: true }] }] });
    return;
  }
  const input = request.artifacts.inputs[0];
  if (input) {
    const bytes = fs.readFileSync(input.path);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (input.field !== '/input/artifact_id' || input.artifact_id !== request.input.input.artifact_id
      || input.sha256 !== digest || input.size !== bytes.length) process.exit(3);
  }
  mark('ready', { work: process.cwd(), copy: input?.path, field: input?.field });
  const mode = request.input.input.mode;
  if (mode === 'hold' || mode === 'ignore') hold = setInterval(() => {}, 1000);
  else if (mode === 'release') hold = setInterval(() => {
    if (fs.existsSync(path.join(root, 'release'))) complete();
  }, 10);
  else if (request.input.input.delay_ms) responseTimer = setTimeout(complete, request.input.input.delay_ms);
  else complete();
});

lines.on('close', () => {
  mark('stdin_eof');
  eof = true;
  // 协议 2 的 EOF 表示初始输入写完，不能误认为取消。
  finishAfterEof();
});
