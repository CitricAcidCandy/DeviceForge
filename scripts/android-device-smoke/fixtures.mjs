import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { exited } from '../device-provider/fixtures.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export const localId = '模拟:甲', otherId = 'emulator-5556', offlineId = 'offline-0001';
export const deviceCapabilities = ['packages', 'app.start', 'app.stop', 'app.uninstall', 'input', 'app.install', 'app.install_apks', 'screenshot'];
export const samples = [
  { id: localId, state: 'online', raw_state: 'device', model: '模拟甲' },
  { id: otherId, state: 'online', raw_state: 'device', model: '模拟乙' },
  { id: offlineId, state: 'offline', raw_state: 'offline', reason: '设备离线' },
  { id: 'error:serial', state: 'unknown', raw_state: 'vendor_state', model: '未知型号', reason: '设备原始状态暂不允许动作' },
];
export const rawDevices = samples.map(({ reason, ...device }) => ({ ...device,
  capabilities: deviceCapabilities.map((id) => ({ id, version: 1, available: reason === undefined,
    ...(reason === undefined ? {} : { reason }) })) }));
export const directoryDevices = samples.map(({ id: local_id, reason, ...device }) => ({ ...device, local_id,
  capabilities: deviceCapabilities.map((id) => ({ id, version: 1, available: reason === undefined, reason: reason ?? null })) }));

export async function prepareTool(directory, toolBinary, report) {
  const toolRoot = join(directory, 'tool'), observations = join(toolRoot, 'observations');
  await mkdir(observations, { recursive: true });
  const scratchRoot = join(directory, 'android-private-scratch');
  await mkdir(scratchRoot);
  const copiedTool = join(toolRoot, process.platform === 'win32' ? 'fake-adb.exe' : 'fake-adb');
  await copyFile(toolBinary, copiedTool);
  const copiedJava = join(toolRoot, process.platform === 'win32' ? 'fake-java.exe' : 'fake-java');
  await copyFile(toolBinary, copiedJava);
  const bundletoolJar = join(toolRoot, 'bundletool 模拟.jar');
  await writeFile(bundletoolJar, '独立假Java读取的普通JAR占位文件', { flag: 'wx' });
  const pixelBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxU0AAAAASUVORK5CYII=', 'base64');
  await writeFile(join(toolRoot, 'pixel.png'), pixelBytes, { flag: 'wx' });
  const original = await fileIdentity(toolBinary), actual = await fileIdentity(copiedTool);
  assert.equal(actual.sha256, original.sha256); await writeFile(join(toolRoot, 'mode'), 'normal', { flag: 'wx' });
  // 性能会话A最多三段120秒运行及其余三会话；单独预留有界工具目录，默认APKS限制保持100。
  const observationLimit = report.performance_mode ? 4096 : 100;
  report.fake_adb = { original, actual, pixel: await fileIdentity(join(toolRoot, 'pixel.png')), observation_limit: observationLimit,
    boundary: '独立std-only假工具；实际argv、父插件路径及PID观测，不涉及真机或共享ADB daemon' };
  const java = await fileIdentity(copiedJava); assert.equal(java.sha256, original.sha256);
  report.fake_java = { actual: java, jar: await fileIdentity(bundletoolJar),
    boundary: '同一std-only二进制的明确Java入口；占位JAR与合成APKS只证明固定编排，不证明真实JVM/bundletool匹配安装' };
  const capabilities = report.performance_mode ? [...deviceCapabilities, 'performance.sample'] : deviceCapabilities;
  const raw = samples.map(({ reason, ...device }) => ({ ...device, capabilities: capabilities.map(id => ({ id, version: 1,
    available: reason === undefined, ...(reason === undefined ? {} : { reason }) })) }));
  const directories = samples.map(({ id: local_id, reason, ...device }) => ({ ...device, local_id,
    capabilities: capabilities.map(id => ({ id, version: 1, available: reason === undefined, reason: reason ?? null })) }));
  return { toolRoot, copiedTool, copiedJava, bundletoolJar, observations, observationLimit, scratchRoot, pixelBytes, rawDevices: raw, directoryDevices: directories };
}

export async function configureAdb(deployment, fixture, report) {
  const configPath = join(dirname(deployment.actualBinary), 'android-device.config.json');
  await writeFile(configPath, JSON.stringify({ format_version: 1, tools: { adb: fixture.copiedTool }, scratch_root: fixture.scratchRoot }), { flag: 'wx' });
  fixture.pluginBinary = deployment.actualBinary;
  fixture.configPath = configPath;
  report.deployment.config_injected = true;
  report.deployment.config = await fileIdentity(configPath);
  report.deployment.config_scope = '部署者在二进制旁后置假ADB与独占scratch_root配置；原包及生成清单字节不改';
}

export async function configureApks(fixture, report, { java = true, jar = true } = {}) {
  const tools = { adb: fixture.copiedTool,
    ...(java ? { java: fixture.copiedJava } : {}),
    ...(jar ? { bundletool: { kind: 'java_jar', jar: fixture.bundletoolJar } } : {}),
  };
  const temporary = fixture.configPath + '.tmp';
  await writeFile(temporary, JSON.stringify({ format_version: 1, tools, scratch_root: fixture.scratchRoot }));
  await rename(temporary, fixture.configPath);
  report.deployment.config = await fileIdentity(fixture.configPath);
  report.deployment.config_phases ??= [];
  report.deployment.config_phases.push({ java, jar, identity: report.deployment.config });
}

export async function setMode(fixture, mode) {
  assert.ok(['normal', 'hold', 'duplicate', 'diagnostic', 'apks-empty', 'apks-lossy'].includes(mode));
  const temporary = join(fixture.toolRoot, 'mode.tmp');
  await writeFile(temporary, mode); await rename(temporary, join(fixture.toolRoot, 'mode'));
}

export async function observations(fixture) {
  const entries = await readdir(fixture.observations, { withFileTypes: true });
  assert.ok(entries.length <= (fixture.observationLimit ?? 100), 'AD-BOUNDED-OBSERVATION-DIRECTORIES');
  const found = [];
  for (const entry of entries) {
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    const directory = join(fixture.observations, entry.name);
    let ready;
    try { ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.equal(ready.event, 'ready'); assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
    assert.ok(Number.isSafeInteger(ready.plugin_pid) && ready.plugin_pid > 0 && ready.plugin_pid !== ready.pid);
    assert.equal(await realpath(ready.plugin_executable), await realpath(fixture.pluginBinary));
    found.push({ directory, ready });
  }
  return found.sort((left, right) => BigInt(left.ready.unix_ns) < BigInt(right.ready.unix_ns) ? -1 : 1);
}

export const keys = async (fixture) => (await observations(fixture)).map((item) => item.directory).sort();
export async function started(fixture, before, argv) {
  return poll(async () => (await observations(fixture)).filter((item) => !before.includes(item.directory)), (added) => {
    assert.ok(added.length <= 1, '本次启动只允许一个工具');
    return added.length === 1;
  }, '真实假ADB启动', 12000).then((added) => {
    if (typeof argv === 'function') argv(added[0].ready.argv);
    else assert.deepEqual(added[0].ready.argv, argv);
    return added[0];
  });
}
export async function release(item) {
  const temporary = join(item.directory, 'release.tmp');
  await writeFile(temporary, '1'); await rename(temporary, join(item.directory, 'release'));
}
export async function finishedTool(item, { cancelled = false } = {}) {
  await poll(async () => exited(item.ready.pid) && exited(item.ready.plugin_pid), Boolean, '真实工具与父插件PID不可见', 5000);
  if (!cancelled) {
    const completed = JSON.parse(await readFile(join(item.directory, 'completed.json'), 'utf8'));
    for (const field of ['pid', 'plugin_pid', 'plugin_executable', 'argv']) assert.deepEqual(completed[field], item.ready[field]);
    assert.equal(completed.event, 'response_written_exit_intent'); assert.equal(completed.code, 0);
    assert.ok(BigInt(completed.unix_ns) >= BigInt(item.ready.unix_ns)); item.completed = completed;
  }
  return { ...item, direct_tool_pid_gone: true, direct_plugin_pid_gone: true, cancelled,
    boundary: 'ready记录真实父插件路径；PID不可见与退出意图区分，不提供OS退出码、派生树或设备状态回滚证明' };
}
