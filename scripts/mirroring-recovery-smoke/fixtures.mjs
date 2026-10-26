import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareFixture, readIfExists } from '../mirroring-streaming-smoke/fixtures.mjs';
import { fixtureState, waitActualMedia } from '../mirroring-cleanup-fallback-smoke/fixtures.mjs';
import { assertListenerReleased } from '../unified-discovery-smoke/host.mjs';

export { fixtureState, readIfExists, waitActualMedia };

export async function prepareRecoveryFixture(directory, binary, name, version, runId) {
  const device = 'cleanup-' + name, nextDevice = 'retry-after-' + name;
  const fixture = await prepareFixture(directory, binary, { [device]: {}, [nextDevice]: {} });
  await writeFile(join(fixture.root, 'fixture-owner'), runId, { flag: 'wx' });
  // 故障只在媒体就绪后注入；首次打开的旧资源审计不能被清理故障提前污染。
  for (const [id, mode] of [[device, 'success'], [nextDevice, 'success']]) {
    await writeFile(join(fixture.plan(id), 'mode'), mode, { flag: 'wx' });
    await writeFile(join(fixture.plan(id), 'server-version'), version, { flag: 'wx' });
  }
  return { ...fixture, device, nextDevice };
}

export async function setMode(fixture, device, mode) {
  assert.ok(['success', 'list-always', 'foreign-forward', 'pid-mismatch', 'list-pair'].includes(mode));
  assert.ok([fixture.device, fixture.nextDevice].includes(device));
  await writeFile(join(fixture.plan(device), 'mode'), mode, 'utf8');
}

export async function toolCount(fixture) {
  return (await readdir(fixture.root)).filter((name) => /^call-\d{3}$/.test(name)).length;
}

export async function verifyPorts(fixture, report) {
  report.fixture_ports = [];
  for (const device of [fixture.device, fixture.nextDevice]) {
    const bytes = await readIfExists(join(fixture.plan(device), 'port'));
    if (!bytes) continue;
    const port = Number(bytes.toString('utf8'));
    assert.ok(Number.isSafeInteger(port) && port > 0 && ![7031, 5173].includes(port));
    const entry = { device, port, released: false };
    report.fixture_ports.push(entry);
    await assertListenerReleased(port);
    entry.released = true;
  }
}

export async function assertNoOwnedResources(fixture, device) {
  const state = await fixtureState(fixture, device);
  for (const key of ['remote-dir', 'remote-pid', 'remote-owner', 'forward-owned', 'forward-device', 'forward-scid'])
    assert.equal(state[key], null, '不得保留本次可确认资源：' + key);
  assert.equal(state['remote-cleaned'], '1');
  assert.equal(state['forward-removed'], '1');
  return state;
}
