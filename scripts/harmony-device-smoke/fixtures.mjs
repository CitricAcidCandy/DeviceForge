import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { exited } from '../device-provider/fixtures.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export const localId = 'HDC001',
  otherId = 'HDC002';
export const capabilities = [
  'packages',
  'app.install',
  'app.uninstall',
  'app.detail',
  'app.start',
  'app.stop',
  'app.reset',
];
export const rawDevices = [localId, otherId].map((id) => ({
  id,
  state: 'online',
  raw_state: 'device',
  capabilities: capabilities.map((id) => ({ id, version: 1, available: true })),
}));
export const directoryDevices = [localId, otherId].map((local_id) => ({
  local_id,
  state: 'online',
  raw_state: 'device',
  capabilities: capabilities.map((id) => ({ id, version: 1, available: true, reason: null })),
}));

export async function prepareTool(directory, toolBinary, report) {
  const toolRoot = join(directory, 'tool'),
    observations = join(toolRoot, 'observations');
  await mkdir(observations, { recursive: true });
  const scratchRoot = join(directory, 'harmony-private-scratch');
  await mkdir(scratchRoot);
  const copiedTool = join(toolRoot, process.platform === 'win32' ? 'fake-hdc.exe' : 'fake-hdc');
  await copyFile(toolBinary, copiedTool);
  await writeFile(join(toolRoot, 'mode'), 'normal', { flag: 'wx' });
  const original = await fileIdentity(toolBinary),
    actual = await fileIdentity(copiedTool);
  assert.equal(original.sha256, actual.sha256);
  report.fake_hdc = {
    original,
    actual,
    boundary: '独立std-only假HDC；实际argv、父插件路径及直接PID观测，不证明真机或共享daemon',
  };
  return { toolRoot, copiedTool, observations, scratchRoot };
}
export async function configureHdc(deployment, fixture, report) {
  const configPath = join(dirname(deployment.actualBinary), 'harmony-device.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      format_version: 1,
      tools: { hdc: fixture.copiedTool },
      scratch_root: fixture.scratchRoot,
    }) + '\n',
    { flag: 'wx' },
  );
  fixture.pluginBinary = deployment.actualBinary;
  report.deployment.config_injected = true;
  report.deployment.config = await fileIdentity(configPath);
}
export async function setMode(fixture, mode) {
  assert.ok(
    [
      'normal',
      'hold',
      'duplicate',
      'prefixed-detail',
      'duplicate-detail',
      'ambiguous-success',
      'stderr-diagnostic',
      'detail-full',
      'detail-no-entry',
      'detail-title',
      'detail-wrong-title',
      'detail-array',
      'detail-duplicate',
      'detail-tail',
      'detail-depth',
      'detail-nodes',
      'detail-stdout-utf8',
      'detail-stderr-utf8',
      'detail-stderr-fail',
      'detail-hold',
      'network-repeat',
      'network-hold',
      'network-fail-stdout',
      'network-fail-stderr',
      'network-stdout-utf8',
      'network-stderr-utf8',
      'network-nonzero',
      'network-empty',
      'network-unknown',
    ].includes(mode),
  );
  await writeFile(join(fixture.toolRoot, 'mode.tmp'), mode);
  await rename(join(fixture.toolRoot, 'mode.tmp'), join(fixture.toolRoot, 'mode'));
}
export async function observations(fixture) {
  const entries = await readdir(fixture.observations, { withFileTypes: true });
  assert.ok(entries.length <= 200);
  const found = [];
  for (const entry of entries) {
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    const directory = join(fixture.observations, entry.name);
    let ready;
    try {
      ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    assert.equal(ready.event, 'ready');
    assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
    assert.ok(
      Number.isSafeInteger(ready.plugin_pid) &&
        ready.plugin_pid > 0 &&
        ready.plugin_pid !== ready.pid,
    );
    assert.equal(await realpath(ready.plugin_executable), await realpath(fixture.pluginBinary));
    found.push({ directory, ready });
  }
  return found.sort((left, right) =>
    BigInt(left.ready.unix_ns) < BigInt(right.ready.unix_ns) ? -1 : 1,
  );
}
export const keys = async (fixture) =>
  (await observations(fixture)).map((item) => item.directory).sort();
export async function started(fixture, before, argv) {
  const added = await poll(
    async () => (await observations(fixture)).filter((item) => !before.includes(item.directory)),
    (items) => {
      assert.ok(items.length <= 1, 'HD-TOOL-SINGLE');
      return items.length === 1;
    },
    '真实假HDC启动',
  );
  if (typeof argv === 'function') argv(added[0].ready.argv);
  else assert.deepEqual(added[0].ready.argv, argv);
  return added[0];
}
export async function release(item) {
  await writeFile(join(item.directory, 'release.tmp'), '1');
  await rename(join(item.directory, 'release.tmp'), join(item.directory, 'release'));
}
export async function finishedTool(item, { cancelled = false, intentCode = 0 } = {}) {
  await poll(
    async () => exited(item.ready.pid) && exited(item.ready.plugin_pid),
    Boolean,
    '工具与父插件直接PID不可见',
    5000,
  );
  if (!cancelled) {
    const completed = JSON.parse(await readFile(join(item.directory, 'completed.json'), 'utf8'));
    for (const field of ['pid', 'plugin_pid', 'plugin_executable', 'argv'])
      assert.deepEqual(completed[field], item.ready[field]);
    assert.equal(completed.event, 'response_written_exit_intent');
    assert.equal(completed.code, intentCode);
    assert.ok(BigInt(completed.unix_ns) >= BigInt(item.ready.unix_ns));
    item.completed = completed;
  }
  return {
    ...item,
    direct_tool_pid_gone: true,
    direct_plugin_pid_gone: true,
    cancelled,
    boundary: 'PID不可见及响应写完退出意图；不是OS退出码、派生树或设备状态回滚证明',
  };
}
