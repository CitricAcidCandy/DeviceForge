// 夹具只探测本次终端与派生树，不访问模型、设备或用户配置。
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const mode = process.argv[2] ?? 'probe';
const identity = process.argv[3];
const mark = (kind, value) => process.stdout.write(`\r\nDFPTY:${kind}:${JSON.stringify(value)}\r\n`);
const size = () => ({ cols: process.stdout.columns, rows: process.stdout.rows });
if (identity) writeFileSync(identity, JSON.stringify({ pid: process.pid }));
if (mode === 'branch') {
  const child = spawn(process.execPath, [__filename, 'leaf', identity + '.child'], {
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('error', () => process.exit(71));
}
if (mode === 'leaf') {
  const child = spawn(process.execPath, [__filename, 'grandchild', identity + '.grandchild'], {
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('error', () => process.exit(72));
}
if (mode !== 'probe') {
  mark('TREE', { pid: process.pid, parent: process.ppid, mode });
  setInterval(() => {}, 1000);
} else {
  let inputBytes = Buffer.alloc(0);
  mark('READY', {
    pid: process.pid,
    stdin_tty: process.stdin.isTTY === true,
    stdout_tty: process.stdout.isTTY === true,
    ...size(),
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.on('resize', () => mark('RESIZE', size()));
  process.stdin.on('data', (bytes) => {
    inputBytes = Buffer.concat([inputBytes, bytes]);
    mark('INPUT', { hex: bytes.toString('hex'), total_hex: inputBytes.toString('hex') });
    if (bytes.includes(3)) mark('INTERRUPT', { alive: true });
    if (bytes.includes(4)) process.exit(0);
    process.stdout.write('\u001b[31m终端中文🙂\u001b[0m\r\n');
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
