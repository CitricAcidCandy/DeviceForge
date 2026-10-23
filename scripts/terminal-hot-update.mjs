import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDeployment } from './backend-console/deployment.mjs';
import { processSnapshot, sameBinary, sameIdentity } from './backend-console/identities.mjs';

// 使用 --check-only 仅预检；实际更新由主代理在独占验收通过后统一调用。
// --plugin 指向冻结的新exe；可覆盖 --manifest、--deployment、--base-url、--host 和 --report。

const root = fileURLToPath(new URL('../', import.meta.url));
const defaults = defaultDeployment(root);
const argumentsList = process.argv.slice(2);
const prefixes = ['--plugin=', '--manifest=', '--market=', '--deployment=', '--base-url=', '--host=', '--report='];
assert.ok(argumentsList.every((value) => value === '--check-only' || prefixes.some((prefix) => value.startsWith(prefix))), '存在未知参数');
for (const prefix of [...prefixes, '--check-only']) assert.ok(argumentsList.filter((value) => value.startsWith(prefix)).length <= 1, '参数不能重复');
assert.equal(process.platform, 'win32', '终端热更新目前仅核验Windows宿主身份');
const option = (prefix) => argumentsList.find((value) => value.startsWith(prefix))?.slice(prefix.length);
const sourcePlugin = resolve(option('--plugin=') ?? join(root, 'backend/target/debug/deviceforge-terminal-plugin.exe'));
const sourceManifest = resolve(option('--manifest=') ?? join(root, 'backend/plugins/terminal/manifest.json'));
const sourceMarket = resolve(option('--market=') ?? join(root, 'backend/plugins/terminal/market.json'));
const deployment = await realpath(resolve(option('--deployment=') ?? join(defaults.pluginDirectory, 'terminal')));
const expectedHost = await realpath(resolve(option('--host=') ?? defaults.binary));
const origin = new URL(option('--base-url=') ?? `http://127.0.0.1:${defaults.port}`);
assert.equal(origin.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));
assert.equal(origin.pathname, '/');
assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash, '宿主URL不能包含凭据或附加路径');
const port = Number(origin.port || 80);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const directory = resolve(option('--report=') ?? join(root, 'artifacts/terminal-pty-20261022', 'hot-update-' + randomUUID()));
await mkdir(directory, { recursive: true });
const report = { started_at: new Date().toISOString(), directory, deployment, base: origin.origin,
  mode: argumentsList.includes('--check-only') ? '只读预检' : '热更新', passed: false, blocked: false, requests: [], checks: [] };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => JSON.stringify(canonical(value)) ?? 'null';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
class Blocked extends Error {}
const staging = new Set();
let before, target, manifestPath, marketPath, oldBinary, oldManifest, oldMarket, newBinary, newManifest, newMarket, metadata;
let unloadAttempted = false, replacedBinary = false, replacedManifest = false, replacedMarket = false;
let phase = '读取部署';
async function ordinary(path) {
  const state = await lstat(path);
  assert.ok(state.isFile() && !state.isSymbolicLink(), '受检路径必须为普通文件：' + path);
  return readFile(path);
}
function confined(path) {
  const inside = relative(deployment, path);
  assert.ok(inside && inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside), '只允许更新目标部署目录中的精确入口');
}
async function request(path, method = 'GET') {
  const response = await fetch(new URL(path, origin), { method, signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  report.requests.push({ at: new Date().toISOString(), path, method, status: response.status, log_id: value.log_id ?? null });
  if (!response.ok) throw new Error(`${path}：${value.error?.message ?? response.status}`);
  return value.data;
}
async function identity() {
  const value = await processSnapshot(port);
  assert.equal(value.listeners.length, 1, '必须取得唯一监听宿主身份');
  const result = value.listeners[0];
  assert.ok(sameBinary(result.binary, expectedHost), '端口宿主不是指定冻结入口，拒绝更新');
  return result;
}
async function sameHost() {
  const current = await identity();
  assert.ok(sameIdentity(before.host, current), '宿主PID、创建时间或入口发生变化，停止热更新');
  return current;
}
function pluginState(plugin) {
  assert.ok(plugin && plugin.id === 'terminal', '终端插件未注册');
  assert.equal(plugin.cleanup_failed, false, '插件清理失败时不能更新');
  assert.equal(plugin.protected, false, '插件保护状态下不能更新');
  assert.notEqual(plugin.state, 'draining', '插件仍在释放中');
}
function configState(value) {
  assert.equal(value.id, 'terminal');
  assert.equal(value.kind, 'server');
  return { revision: value.revision, applied_revision: value.applied_revision, source: value.source,
    pending_reload: value.pending_reload, compatible: value.compatible, values_sha256: digest(stable(value.values)) };
}
async function snapshot(strict = true) {
  const host = await identity();
  const plugins = await request('/api/v2/plugins');
  const sessions = await request('/api/v2/sessions');
  const configuration = configState(await request('/api/v2/plugin-configurations/server/terminal'));
  const terminal = plugins.find((value) => value.id === 'terminal');
  if (strict) pluginState(terminal);
  const others = plugins.filter((value) => value.id !== 'terminal').map((value) => ({
    id: value.id, state: value.state, generation: value.generation, protected: value.protected,
    cleanup_failed: value.cleanup_failed, operations: value.operations, sessions: value.sessions,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const sessionStates = sessions.map((value) => ({
    id: value.id, operation: value.operation, plugin_id: value.plugin_id, generation: value.generation,
    status: value.status, completion_sha256: digest(stable(value.completion)),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return { host, terminal: terminal ? { state: terminal.state, generation: terminal.generation,
    protected: terminal.protected, cleanup_failed: terminal.cleanup_failed, operations: terminal.operations, sessions: terminal.sessions } : null, configuration,
    other_plugins: others, sessions: sessionStates,
    active_terminal: sessions.filter((value) => value.plugin_id === 'terminal' && value.status !== 'finished').map((value) => ({ id: value.id, status: value.status, generation: value.generation })) };
}
function noTerminalSessions(value) {
  if (value.active_terminal.length) throw new Blocked('终端仍有活动会话，未取消会话或卸载插件');
}
function preserved(value) {
  assert.ok(sameIdentity(before.host, value.host), '热更新不得重启或替换宿主');
  assert.equal(stable(value.configuration), stable(before.configuration), '用户终端配置修订或值发生变化');
  assert.equal(stable(value.other_plugins), stable(before.other_plugins), '其他插件身份、代次或贡献发生变化');
  assert.equal(stable(value.sessions), stable(before.sessions), '既有会话身份或状态发生变化，或出现新会话');
}
async function staged(bytes, destination) {
  const path = join(dirname(destination), `.${basename(destination)}-${randomUUID()}.pending`);
  confined(path);
  const handle = await open(path, 'wx');
  staging.add(path);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  assert.equal(digest(await ordinary(path)), digest(bytes));
  return path;
}
async function replace(bytes, destination) {
  const path = await staged(bytes, destination);
  await rename(path, destination);
  staging.delete(path);
  assert.equal(digest(await ordinary(destination)), digest(bytes));
}
async function recover() {
  report.recovery_attempted = true;
  await sameHost();
  let current = await snapshot();
  noTerminalSessions(current);
  if (current.terminal.state === 'loaded') {
    const stopped = await request('/api/v2/plugins/terminal/unload', 'POST');
    pluginState(stopped); assert.equal(stopped.state, 'unloaded');
  } else assert.equal(current.terminal.state, 'unloaded', '未知插件状态下不覆盖部署');
  await sameHost();
  // 只有文件仍为本驱动写入的字节才恢复，不能覆盖其他会话的并发编辑。
  if (replacedBinary) {
    assert.equal(digest(await ordinary(target)), digest(newBinary), '插件入口已被外部修改，保留真实状态');
    await replace(oldBinary, target);
    report.binary_restored = true;
  }
  if (replacedManifest) {
    assert.equal(digest(await ordinary(manifestPath)), digest(newManifest), '插件清单已被外部修改，保留真实状态');
    await replace(oldManifest, manifestPath);
    report.manifest_restored = true;
  }
  if (replacedMarket) {
    assert.equal(digest(await ordinary(marketPath)), digest(newMarket), '插件展示资料已被外部修改，保留真实状态');
    await replace(oldMarket, marketPath);
    report.market_restored = true;
  }
  // 未发生本驱动替换的文件仍需与原部署相同，否则不擅自加载外部变更。
  assert.equal(digest(await ordinary(target)), digest(oldBinary));
  assert.equal(digest(await ordinary(manifestPath)), digest(oldManifest));
  assert.equal(digest(await ordinary(marketPath)), digest(oldMarket));
  const loaded = await request('/api/v2/plugins/terminal/load', 'POST');
  pluginState(loaded); assert.equal(loaded.state, 'loaded');
  current = await snapshot();
  preserved(current);
  report.recovery_after = current;
  report.previous_deployment_restored = true;
}

try {
  phase = '核对宿主、插件、配置和活动会话';
  before = await snapshot(); report.before = before;
  assert.equal(before.terminal.state, 'loaded', '只热更新已经加载的终端插件');
  noTerminalSessions(before);
  assert.equal(before.configuration.pending_reload, false, '存在待应用配置时不隐式应用');
  assert.equal(before.configuration.compatible, true, '配置不兼容时不能热更新');
  phase = '读取并校验冻结输入';
  manifestPath = await realpath(join(deployment, 'manifest.json')); confined(manifestPath);
  oldManifest = await ordinary(manifestPath);
  marketPath = await realpath(join(deployment, 'market.json')); confined(marketPath);
  oldMarket = await ordinary(marketPath);
  newMarket = await ordinary(sourceMarket);
  metadata = JSON.parse(newMarket.toString('utf8'));
  const previous = JSON.parse(oldManifest.toString('utf8'));
  assert.equal(previous.id, 'terminal'); assert.equal(typeof previous.executable, 'string'); assert.ok(Array.isArray(previous.args));
  const resolvedEntry = isAbsolute(previous.executable) ? previous.executable : resolve(deployment, previous.executable);
  target = await realpath(resolvedEntry); confined(target);
  assert.ok(!sameBinary(sourcePlugin, target), '受检新插件必须为独立冻结输入，不能覆盖自身');
  oldBinary = await ordinary(target);
  newBinary = await ordinary(sourcePlugin);
  assert.equal(newBinary.subarray(0, 2).toString(), 'MZ', '新插件不是Windows PE文件');
  const updated = JSON.parse((await ordinary(sourceManifest)).toString('utf8'));
  assert.equal(updated.id, 'terminal'); assert.equal(updated.protocol_version, 4);
  assert.equal(metadata.metadata_version, 1); assert.equal(metadata.id, 'terminal'); assert.equal(metadata.version, updated.version);
  for (const key of ['name', 'summary', 'description']) assert.ok(typeof metadata[key] === 'string' && metadata[key].trim());
  assert.equal(updated.sessions.protocol_version, 5);
  const opening = updated.sessions.operations.find((value) => value.name === 'open');
  assert.equal(opening?.input_schema?.properties?.terminal?.properties?.protocol?.const, 'deviceforge.terminal.v1', '新清单缺少PTY合同');
  updated.executable = previous.executable;
  updated.args = previous.args;
  // 此次只升级终端执行合同；本地部署的配置定义和默认值保持原样。
  updated.configuration = previous.configuration;
  newManifest = Buffer.from(JSON.stringify(updated, null, 2) + '\n');
  report.files = { entry: target, plugin_source: sourcePlugin, manifest_source: sourceManifest,
    old_plugin_sha256: digest(oldBinary), plugin_sha256: digest(newBinary),
    old_manifest_sha256: digest(oldManifest), manifest_sha256: digest(newManifest),
    market_source: sourceMarket, old_market_sha256: digest(oldMarket), market_sha256: digest(newMarket),
    executable_preserved: true, args_preserved: true, configuration_definition_preserved: true };
  if (report.mode === '只读预检') {
    report.after = await snapshot(); preserved(report.after); noTerminalSessions(report.after);
    report.checks.push('宿主完整身份已核对', '无活动终端', '输入和目标部署已校验', '未修改部署');
  } else {
    await writeFile(join(directory, 'previous-plugin.exe'), oldBinary, { flag: 'wx' });
    await writeFile(join(directory, 'previous-manifest.json'), oldManifest, { flag: 'wx' });
    await writeFile(join(directory, 'previous-market.json'), oldMarket, { flag: 'wx' });
    const stagedBinary = await staged(newBinary, target);
    const stagedManifest = await staged(newManifest, manifestPath);
    const stagedMarket = await staged(newMarket, marketPath);
    phase = '卸载前再次核对准入和文件';
    const latest = await snapshot(); preserved(latest); noTerminalSessions(latest);
    assert.equal(latest.terminal.generation, before.terminal.generation, '终端代次已变化，停止更新');
    assert.equal(digest(await ordinary(target)), digest(oldBinary), '旧入口已被并发修改');
    assert.equal(digest(await ordinary(manifestPath)), digest(oldManifest), '旧清单已被并发修改');
    assert.equal(digest(await ordinary(marketPath)), digest(oldMarket), '旧展示资料已被并发修改');
    phase = '公开卸载终端插件'; unloadAttempted = true;
    const stopped = await request('/api/v2/plugins/terminal/unload', 'POST');
    pluginState(stopped); assert.equal(stopped.state, 'unloaded');
    await sameHost();
    phase = '原子替换精确部署入口与清单';
    assert.equal(digest(await ordinary(target)), digest(oldBinary), '卸载期间旧入口被修改');
    assert.equal(digest(await ordinary(manifestPath)), digest(oldManifest), '卸载期间旧清单被修改');
    assert.equal(digest(await ordinary(marketPath)), digest(oldMarket), '卸载期间旧展示资料被修改');
    await rename(stagedBinary, target); staging.delete(stagedBinary); replacedBinary = true;
    await rename(stagedManifest, manifestPath); staging.delete(stagedManifest); replacedManifest = true;
    await rename(stagedMarket, marketPath); staging.delete(stagedMarket); replacedMarket = true;
    phase = '公开加载新终端代次';
    const loaded = await request('/api/v2/plugins/terminal/load', 'POST');
    pluginState(loaded); assert.equal(loaded.state, 'loaded');
    assert.notEqual(loaded.generation, before.terminal.generation, '插件代次必须更新');
    assert.ok(loaded.sessions.includes('plugin.terminal.open'));
    assert.deepEqual(loaded.metadata, { name: metadata.name, summary: metadata.summary, description: metadata.description }, '加载后展示资料必须来自新market.json');
    phase = '复核宿主、用户配置和其他插件会话';
    report.after = await snapshot(); preserved(report.after);
    assert.equal(digest(await ordinary(target)), digest(newBinary));
    assert.equal(digest(await ordinary(manifestPath)), digest(newManifest));
    assert.equal(digest(await ordinary(marketPath)), digest(newMarket));
    assert.equal((await request('/api/v2/health')).status, 'ok');
    report.checks.push('无活动终端时才卸载', '公开卸载加载及代次更新', '备份与原子替换', '宿主完整身份不变', '入口路径和args不变', '用户配置值与修订不变', '其他插件和会话身份状态不变');
  }
  report.passed = true;
} catch (error) {
  report.failure = { phase, name: error.name, message: error.message };
  report.blocked = error instanceof Blocked;
  if (unloadAttempted) {
    try { await recover(); }
    catch (recoveryError) { report.recovery_failure = { name: recoveryError.name, message: recoveryError.message }; }
  }
  process.exitCode = report.blocked ? 2 : 1;
} finally {
  for (const path of staging) {
    try { await unlink(path); }
    catch (error) { if (error.code !== 'ENOENT') (report.staging_cleanup_failures ??= []).push({ path, message: error.message }); }
  }
  if (report.staging_cleanup_failures?.length) { report.passed = false; process.exitCode = 1; }
  if (before) {
    try { report.observed_final_state = await snapshot(false); }
    catch (error) { report.final_observation_failure = { name: error.name, message: error.message }; }
  }
  report.mutation = { unload_attempted: unloadAttempted, binary_replaced: replacedBinary, manifest_replaced: replacedManifest, market_replaced: replacedMarket };
  report.completed_at = new Date().toISOString();
  const path = join(directory, 'report.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, blocked: report.blocked, report: path, failure: report.failure,
    previous_deployment_restored: report.previous_deployment_restored ?? false, recovery_failure: report.recovery_failure }));
}
