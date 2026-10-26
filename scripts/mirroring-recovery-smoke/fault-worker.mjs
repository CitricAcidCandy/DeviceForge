import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// 本夹具故意输出不合格报告，只用于验证真实宿主；不冒充生产投屏插件。
const [rootArgument, recoverBinaryOption, recoverConfigOption] = process.argv.slice(2);
assert.ok(rootArgument?.startsWith('--root='));
const root = rootArgument.slice(7);
assert.ok(isAbsolute(root) && existsSync(join(root, 'fault-fixture-owner')));
const recoverBinary = recoverBinaryOption?.slice('--recover-binary='.length);
const recoverConfig = recoverConfigOption?.slice('--recover-config='.length);
if (recoverBinaryOption) assert.ok(recoverBinaryOption.startsWith('--recover-binary=') && isAbsolute(recoverBinary) &&
  recoverConfigOption?.startsWith('--recover-config=') && isAbsolute(recoverConfig));
const call = join(root, 'call-' + randomUUID());
const write = (value) => new Promise((done, reject) => {
  process.stdout.write(JSON.stringify(value) + '\n', (error) => error ? reject(error) : done());
});
const watchdog = setInterval(() => {
  if (existsSync(join(root, 'stop-fixture'))) process.exit(96);
}, 10);
const orphan = setTimeout(() => process.exit(97), 60000);
let request, started = false, finished = false, sequence = 0, handling = Promise.resolve();
let forwarded;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function identity() {
  return request.protocol_version === 5
    ? { protocol_version: 5, session_id: request.session_id }
    : { protocol_version: 4, request_id: request.request_id };
}

function reportFor(mode) {
  const report = {
    status: 'recovered', coverage: 'plugin', inspected: 1, remaining: 0,
    message: '受控故障报告', checks: [{ resource: 'fixture', status: 'confirmed', message: '受控检查' }],
  };
  if (mode === 'coverage-omitted') delete report.coverage;
  else if (mode === 'coverage-empty') report.coverage = '';
  else if (mode === 'coverage-device') report.coverage = 'device';
  else if (mode === 'inspected-omitted') delete report.inspected;
  else if (mode === 'remaining-omitted') delete report.remaining;
  else if (mode === 'checks-empty') report.checks = [];
  else if (mode === 'remaining-positive') report.remaining = 1;
  else assert.equal(mode, 'hanging-after-report');
  return report;
}

async function receive(value) {
  if (forwarded) {
    forwarded.stdin.write(JSON.stringify(value) + '\n');
    return;
  }
  if (!request) {
    assert.ok([4, 5].includes(value.protocol_version));
    assert.equal(value.operation, value.protocol_version === 5 ? 'open' : 'runtime.recover');
    request = value;
    writeFileSync(call + '.ready.json', JSON.stringify({ pid: process.pid,
      protocol_version: value.protocol_version, operation: value.operation,
      id: value.session_id ?? value.request_id }), { flag: 'wx' });
    const deadline = Date.now() + 4000;
    while (!existsSync(call + '.release')) {
      assert.ok(Date.now() < deadline, '原生探针未放行本轮夹具');
      await delay(5);
    }
    if (request.protocol_version === 4 && recoverBinary) {
      forwarded = spawn(recoverBinary, ['--config', recoverConfig], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      writeFileSync(call + '.forwarded.json', JSON.stringify({ pid: forwarded.pid, executable: recoverBinary }), { flag: 'wx' });
      forwarded.stdout.pipe(process.stdout); forwarded.stderr.pipe(process.stderr);
      forwarded.once('error', () => process.exit(91));
      forwarded.once('close', (code, signal) => {
        writeFileSync(call + '.forwarded-exit.json', JSON.stringify({ pid: forwarded.pid, code, signal }), { flag: 'wx' });
        clearInterval(watchdog); clearTimeout(orphan);
        process.exit(code === 0 && signal === null ? 0 : 90);
      });
      forwarded.stdin.write(JSON.stringify(value) + '\n');
      return;
    }
    await write({ ...identity(), command: 'ready' });
    return;
  }
  const id = identity();
  for (const [key, expected] of Object.entries(id)) assert.equal(value[key], expected);
  if (!started) {
    assert.equal(value.command, 'start');
    assert.ok(Number.isSafeInteger(value.remaining_timeout_ns) && value.remaining_timeout_ns > 0);
    started = true;
    writeFileSync(call + '.started', '1', { flag: 'wx' });
    if (request.protocol_version === 5) {
      await write({ ...id, event: 'output', sequence: ++sequence, stream: 'stdout', bytes: [82] });
      return;
    }
    const mode = readFileSync(join(root, 'mode'), 'utf8');
    await write({ response: { ...id, result: reportFor(mode) }, cleanup: 'complete' });
    writeFileSync(call + '.response-written', mode, { flag: 'wx' });
    if (mode === 'hanging-after-report') return;
    finished = true;
    clearInterval(watchdog); clearTimeout(orphan);
    process.exit(0);
  }
  if (request.protocol_version === 5 && value.command === 'cancel') {
    assert.equal(finished, false);
    finished = true;
    await write({ ...id, event: 'finished', sequence: ++sequence,
      outcome: { result: null, cleanup: 'failed' } });
    writeFileSync(call + '.cleanup-failed', '1', { flag: 'wx' });
    clearInterval(watchdog); clearTimeout(orphan);
    process.exit(0);
  }
  // 挂住案例故意不响应取消或 EOF，必须由宿主监督结束，而不是测试冒充回收。
  if (request.protocol_version === 4) return;
  assert.equal(value.command, 'eof');
}

lines.on('line', (line) => {
  handling = handling.then(() => { assert.ok(line.length <= 512 * 1024); return receive(JSON.parse(line)); });
  handling.catch(() => process.exit(92));
});
process.stdin.on('error', () => process.exit(93));
process.stdin.on('end', () => forwarded?.stdin.end());
process.stdout.on('error', () => process.exit(94));
