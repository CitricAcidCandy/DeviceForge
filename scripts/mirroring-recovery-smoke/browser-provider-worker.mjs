import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// 仅返回本轮合成设备，绝不派生 ADB/HDC 或访问真实平台。
const [rootOption, deviceOption] = process.argv.slice(2);
assert.ok(rootOption?.startsWith('--root=') && deviceOption?.startsWith('--device='));
const root = rootOption.slice(7), device = deviceOption.slice(9);
assert.ok(isAbsolute(root) && existsSync(join(root, 'fault-fixture-owner')));
assert.match(device, /^cleanup-[a-z-]+$/);
const call = join(root, 'call-' + randomUUID());
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const orphan = setTimeout(() => process.exit(97), 15000);
const stop = setInterval(() => { if (existsSync(join(root, 'stop-fixture'))) process.exit(96); }, 10);
let request;
lines.on('line', (line) => {
  if (request) { process.exit(92); return; }
  request = JSON.parse(line);
  (async () => {
    assert.equal(request.protocol_version, 3);
    assert.ok(['discover', 'inspect'].includes(request.operation));
    writeFileSync(call + '.ready.json', JSON.stringify({ pid: process.pid, protocol_version: 3,
      operation: request.operation, id: request.request_id }), { flag: 'wx' });
    const deadline = Date.now() + 4000;
    while (!existsSync(call + '.release')) {
      assert.ok(Date.now() < deadline, '合成提供者探针未放行');
      await delay(5);
    }
    const result = request.operation === 'discover' ? [{
      id: device, state: 'online', raw_state: 'device', model: '恢复验收合成设备',
      capabilities: [{ id: 'inspect', version: 1, available: true, reason: null }],
    }] : { synthetic_device: true };
    process.stdout.write(JSON.stringify({ response: {
      protocol_version: 3, request_id: request.request_id, result,
    }, cleanup: 'complete' }) + '\n', (error) => {
      clearTimeout(orphan); clearInterval(stop); process.exit(error ? 93 : 0);
    });
  })().catch(() => process.exit(94));
});
