// 独立宿主、固定 Node 插件夹具与真实 HTTP；不访问预览实例或设备。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv.includes('--release') ? 'release' : 'debug';
assert.ok(process.argv.slice(2).every((value) => value === '--release'), '仅支持 --release');
const output = resolve(backend, '..', 'artifacts', `plugin-configurations-${profile}-${randomUUID()}`);
const binary = join(output, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
const deployment = join(output, 'plugins');
const data = join(output, 'data');
const report = {
  timestamp: new Date().toISOString(), profile, output, passed: false,
  scope: '当前 Rust 宿主、真实 HTTP、协议 1 Node 进程夹具与配置文件；不含真机、第三方插件实现或性能结论',
  checks: [], requests: [], hosts: [],
};
let host;
let base;
const check = (name, condition) => { assert.ok(condition, name); report.checks.push(name); };
async function poll(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await delay(20); }
  throw new Error(`等待超时：${label}`);
}
async function port() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
async function released(value) {
  const server = createServer();
  try { await new Promise((done, reject) => { server.once('error', reject); server.listen(value, '127.0.0.1', done); }); await new Promise((done) => server.close(done)); return true; }
  catch { return false; }
}
async function call(path, { method = 'GET', input, status = 200 } = {}) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.equal(body.log_id, logId, '响应关联必须一致');
  assert.match(logId, /^[a-f0-9-]{36}$/);
  report.requests.push({ method, path, status: response.status, log_id: logId, error: body.error?.code });
  assert.equal(response.status, status, `${method} ${path}`);
  return body.data ?? body.error;
}
async function start() {
  const selected = await port();
  base = `http://127.0.0.1:${selected}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)));
  const child = spawn(binary, [], { cwd: output, env: { ...environment, APK_BIND: `127.0.0.1:${selected}`, APK_DATA_DIR: data, APK_PLUGIN_DIR: deployment, DEVICEFORGE_USER_DIR: join(output, 'user', '.deviceforge'), DEVICEFORGE_HTTP_RATE: '10000' }, windowsHide: true, stdio: 'ignore' });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  const entry = { pid: child.pid, port: selected };
  report.hosts.push(entry);
  host = { child, closed, entry };
  await poll(async () => { if (spawnError) throw spawnError; if (child.exitCode !== null) throw new Error('宿主就绪前退出'); try { return (await call('/api/v2/health')).status === 'ok'; } catch { return false; } }, Boolean, '独立宿主就绪');
}
async function stop() {
  if (!host) return;
  await call('/api/v2/system/shutdown', { method: 'POST' });
  const result = await Promise.race([host.closed, delay(12000).then(() => ({ timeout: true }))]);
  assert.equal(result.code, 0, '宿主必须正常退出');
  host.entry.exit = result;
  host.entry.port_released = await released(host.entry.port);
  assert.equal(host.entry.port_released, true);
  host = undefined;
}
const configPath = (id) => `/api/v2/plugin-configurations/server/${id}`;
const manifests = new Map();
async function manifest(id, policy, declared = true) {
  const directory = join(deployment, id);
  await mkdir(directory, { recursive: true });
  const legacy = join(directory, 'legacy.json');
  await writeFile(legacy, JSON.stringify({ count: 3, token: 'fixture-secret', identity: id, headers: { private: 'fixture-header' } }));
  const value = { id, version: '1.0.0', protocol_version: 1, executable: process.execPath,
    args: [join(output, 'fixture.mjs'), '--config', legacy, '--marker', join(directory, 'started')],
    operations: [{ name: 'read', title: '读取受控配置', input_schema: { type: 'object', properties: { delay_ms: { type: 'integer', minimum: 0, maximum: 5000 } }, additionalProperties: false } }],
  };
  if (declared) value.configuration = {
    version: 1, apply_policy: policy, legacy_filename: 'legacy.json',
    schema: { type: 'object', additionalProperties: false, required: ['count', 'identity', 'headers'], properties: {
      count: { type: 'integer', minimum: 1, maximum: 100 }, identity: { type: 'string', readOnly: true },
      token: { type: 'string', writeOnly: true }, headers: { type: 'object', additionalProperties: { type: 'string', writeOnly: true, format: 'password' } },
    } }, defaults: { count: 1, identity: id, headers: {}, token: 'default-fixture' },
  };
  manifests.set(id, value);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(value));
}
async function invoke(id, input = {}) {
  return call('/api/v2/jobs', { method: 'POST', status: 202, input: { operation: `plugin.${id}.read`, input } });
}
async function result(job) {
  const value = await poll(() => call(`/api/v2/jobs/${job.id}`), (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status), '插件任务终态');
  assert.equal(value.status, 'succeeded', '插件任务必须成功');
  return value.result;
}
async function started(id) {
  await poll(async () => { try { return (await readFile(join(deployment, id, 'started'), 'utf8')).length > 0; } catch { return false; } }, Boolean, '原生子进程已读取配置');
}

try {
  await mkdir(deployment, { recursive: true });
  await mkdir(data);
  await copyFile(join(backend, 'target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server'), binary);
  const binaryBytes = await readFile(binary);
  report.host_sha256 = createHash('sha256').update(binaryBytes).digest('hex');
  await copyFile(join(backend, 'scripts/plugin-configurations-smoke/fixture.mjs'), join(output, 'fixture.mjs'));
  // 故意报告未确认清理的协议 3 夹具，不创建任何外部资源。
  await writeFile(join(output, 'cleanup-failed.mjs'), [
    "import { createInterface } from 'node:readline';",
    "import { writeFileSync } from 'node:fs';",
    "const reader = createInterface({ input: process.stdin });",
    "reader.once('line', (line) => {",
    "  const request = JSON.parse(line); reader.close();",
    "  writeFileSync(process.argv[process.argv.indexOf('--marker') + 1], String(process.pid));",
    "  const response = { protocol_version: 3, request_id: request.request_id, result: {} };",
    "  process.stdout.write(JSON.stringify({ response, cleanup: 'failed' }) + '\\n', () => process.exit(0));",
    "});",
  ].join('\n'));
  await manifest('config_next', 'next_invocation');
  await manifest('config_reload', 'plugin_reload');
  await manifest('config_legacy', 'next_invocation', false);
  await manifest('config_failed', 'plugin_reload');
  const failedManifest = structuredClone(manifests.get('config_failed'));
  failedManifest.protocol_version = 3;
  failedManifest.args[0] = join(output, 'cleanup-failed.mjs');
  await writeFile(join(deployment, 'config_failed/manifest.json'), JSON.stringify(failedManifest));
  await start();
  const catalog = await call('/api/v2/plugin-configurations?kind=server');
  check('目录同时包含声明配置与旁置旧插件', catalog.length === 4 && catalog.some((value) => value.id === 'config_legacy' && value.definition === null));
  let current = await call(configPath('config_next'));
  check('首次读取旧配置且敏感映射与普通密码均遮蔽', current.source === 'legacy' && current.revision === 0 && current.values.count === 3 && current.values.token === '********' && current.values.headers.private === '********');
  let actual = await result(await invoke('config_next'));
  check('首次调用即使用用户目录初始配置副本', actual.count === 3 && actual.managed === true && actual.revision_file === '0.json');
  current = await call(configPath('config_next'), { method: 'PATCH', input: { expected_revision: 0, patch: { count: 5, token: '********', headers: { private: '********' } } } });
  check('保存推进修订且下次调用策略立即标为已应用', current.revision === 1 && current.applied_revision === 1 && current.compatible);
  actual = await result(await invoke('config_next'));
  check('新进程实际读取宿主管理修订', actual.count === 5 && actual.managed && actual.revision_file === '1.json');
  const invalid = await call(configPath('config_next'), { method: 'PATCH', input: { expected_revision: 1, patch: { count: 0, identity: 'changed' } } });
  check('非法字段与只读字段不保存并返回定位', invalid.compatible === false && invalid.revision === 1 && invalid.values.count === 5 && invalid.field_errors.some((value) => value.path === '/count') && invalid.field_errors.some((value) => value.path === '/identity'));
  const stale = await call(configPath('config_next'), { method: 'PATCH', status: 409, input: { expected_revision: 0, patch: { count: 6 } } });
  check('过时修订返回CAS409', stale.code === 'conflict');
  current = await call(configPath('config_next') + '/reset', { method: 'POST', input: { expected_revision: 1 } });
  actual = await result(await invoke('config_next'));
  check('恢复默认推进修订且真实生效', current.revision === 2 && actual.count === 1);
  await call(configPath('config_next'), { method: 'PATCH', input: { expected_revision: 2, patch: { count: 7 } } });
  await rm(join(deployment, 'config_next/started'), { force: true });
  const activeNext = await invoke('config_next', { delay_ms: 1200 });
  await started('config_next');
  await call(configPath('config_next'), { method: 'PATCH', input: { expected_revision: 3, patch: { count: 8 } } });
  const preserved = await result(activeNext);
  actual = await result(await invoke('config_next'));
  check('保存不改变活动调用快照而下一调用读取新值', preserved.count === 7 && actual.count === 8);

  current = await call(configPath('config_reload'), { method: 'PATCH', input: { expected_revision: 0, patch: { count: 6 } } });
  check('需要重载的配置保存后保留待应用标记', current.pending_reload && current.revision === 1 && current.applied_revision === 0);
  await rm(join(deployment, 'config_reload/started'), { force: true });
  const activeReload = await invoke('config_reload', { delay_ms: 1200 });
  await started('config_reload');
  const before = (await call('/api/v2/plugins')).find((value) => value.id === 'config_reload');
  await call(configPath('config_reload') + '/apply', { method: 'POST', status: 409, input: { expected_revision: 1 } });
  const retained = (await call('/api/v2/plugins')).find((value) => value.id === 'config_reload');
  check('活动任务拒绝重载且保持旧代际', before.generation === retained.generation && retained.state === 'loaded');
  check('被拒绝的重载不取消活动任务', (await result(activeReload)).count === 3);
  current = await call(configPath('config_reload') + '/apply', { method: 'POST', input: { expected_revision: 1 } });
  const reloaded = (await call('/api/v2/plugins')).find((value) => value.id === 'config_reload');
  actual = await result(await invoke('config_reload'));
  check('空闲应用切换代际并使配置真实生效', !current.pending_reload && current.applied_revision === 1 && reloaded.generation !== before.generation && actual.count === 6);
  await call(configPath('config_reload'), { method: 'PATCH', input: { expected_revision: 1, patch: { count: 9 } } });
  const reloadManifest = structuredClone(manifests.get('config_reload'));
  reloadManifest.operations[0].input_schema = { type: 'array' };
  await writeFile(join(deployment, 'config_reload/manifest.json'), JSON.stringify(reloadManifest));
  await call(configPath('config_reload') + '/apply', { method: 'POST', status: 400, input: { expected_revision: 2 } });
  const failedReload = (await call('/api/v2/plugins')).find((value) => value.id === 'config_reload');
  current = await call(configPath('config_reload'));
  check('新清单验证失败保留旧代际和待应用配置', failedReload?.generation === reloaded.generation && current.pending_reload && current.applied_revision === 1);
  await writeFile(join(deployment, 'config_reload/manifest.json'), JSON.stringify(manifests.get('config_reload')));
  check('失败重载后原插件仍可调用', (await result(await invoke('config_reload'))).count === 6);

  const legacy = await call(configPath('config_legacy'));
  await call(configPath('config_legacy'), { method: 'PATCH', status: 409, input: { expected_revision: 0, patch: {} } });
  actual = await result(await invoke('config_legacy'));
  check('未声明旧包只读兼容且继续原参数调用', legacy.definition === null && Object.keys(legacy.values).length === 0 && actual.count === 3 && actual.managed === false);

  const upgraded = structuredClone(manifests.get('config_next'));
  upgraded.version = '2.0.0';
  upgraded.configuration.version = 2;
  await writeFile(join(deployment, 'config_next/manifest.json'), JSON.stringify(upgraded));
  current = await call(configPath('config_next'));
  check('升级保留已保存原值并明确版本不兼容', current.compatible === false && current.values.count === 8 && current.revision === 4);
  current = await call(configPath('config_next'), { method: 'PATCH', input: { expected_revision: 4, patch: {} } });
  check('显式校验保存确认升级且不丢原值', current.compatible && current.values.count === 8 && current.revision === 5);
  await stop();
  await start();
  current = await call(configPath('config_next'));
  actual = await result(await invoke('config_next'));
  check('宿主重启后配置值与修订持久化并由进程消费', current.revision === 5 && current.values.count === 8 && actual.count === 8 && actual.managed);
  const failedJob = await invoke('config_failed');
  const failedTerminal = await poll(() => call(`/api/v2/jobs/${failedJob.id}`), (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status), '未确认清理任务终态');
  const unresolved = (await call('/api/v2/plugins')).find((value) => value.id === 'config_failed');
  check('协议三未确认清理保留真实失败状态', failedTerminal.status === 'failed' && unresolved.cleanup_failed);
  current = await call(configPath('config_failed'), { method: 'PATCH', input: { expected_revision: 0, patch: { count: 4 } } });
  const rejectedCleanup = await call(configPath('config_failed') + '/apply', { method: 'POST', status: 409, input: { expected_revision: 1 } });
  const keptUnresolved = (await call('/api/v2/plugins')).find((value) => value.id === 'config_failed');
  current = await call(configPath('config_failed'));
  check('未确认清理拒绝配置重载且不清空告警代际', rejectedCleanup.code === 'cleanup_failed' && keptUnresolved.cleanup_failed && keptUnresolved.generation === unresolved.generation && current.pending_reload && current.applied_revision === 0);
  const failedPid = Number(await readFile(join(deployment, 'config_failed/started'), 'utf8'));
  const fixtureExited = await poll(async () => { try { process.kill(failedPid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, Boolean, '清理失败夹具直接进程退出');
  report.cleanup_fixture = { pid: failedPid, exited: fixtureExited };
  check('直接进程退出不能清除插件未确认清理标记', fixtureExited && keptUnresolved.cleanup_failed);
  await stop();
  check('两轮独立宿主均正常退出并释放监听', report.hosts.length === 2 && report.hosts.every((value) => value.exit.code === 0 && value.port_released));
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
} finally {
  if (host) {
    try { await stop(); }
    catch (error) {
      report.cleanup_error = error instanceof Error ? error.message : String(error);
      host.child.kill();
      const result = await host.closed;
      host.entry.exit = result;
      host.entry.port_released = await released(host.entry.port);
    }
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`插件配置 ${profile} 验证：${report.passed ? '通过' : '未通过'}；${report.checks.length}项；证据：${join(output, 'report.json')}`);
  if (!report.passed) process.exitCode = 1;
}
