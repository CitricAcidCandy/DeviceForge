import assert from 'node:assert/strict';
import { lstat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { catalog, fourJobs, plugins, preservedHistory } from './android-packages-online/checks.mjs';
import { pluginId, prepareArchive, settledRoot, verifyArchiveIdentity, verifyInstalled, verifyUnchanged } from './android-packages-online/deployment.mjs';
import { failure, reportFor, retain, verifyLogs, writeReport } from './android-packages-online/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
let profile = 'debug', archive, expectedSha256;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--release') {
    assert.equal(profile, 'debug', '--release不可重复'); profile = 'release';
  } else if (argument === '--archive') {
    assert.equal(archive, undefined, '--archive不可重复'); archive = args[++index];
    assert.ok(archive && isAbsolute(archive), '--archive必须为正式原TGZ绝对路径');
  } else if (argument === '--archive-sha256') {
    assert.equal(expectedSha256, undefined, '--archive-sha256不可重复');
    expectedSha256 = args[++index]; assert.match(expectedSha256 ?? '', /^[a-f\d]{64}$/i);
    expectedSha256 = expectedSha256.toLowerCase();
  } else assert.fail('仅接受--archive、--archive-sha256与--release');
}
assert.ok(archive && expectedSha256, '须显式传入原TGZ路径和compressed bytes SHA256');
const binary = resolve(root, 'backend/target', profile, `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
const report = reportFor(profile);
let directory, context, host;

function owner(info, generation, state) {
  assert.equal(info.id, pluginId); assert.equal(info.version, context.manifest.version);
  assert.equal(info.state, state); assert.equal(info.cleanup_failed, false);
  assert.match(info.generation, uuid);
  if (generation !== undefined) assert.equal(info.generation, generation);
  return info;
}

async function packages(expected) {
  assert.deepEqual(await host.client.json('/api/v2/plugin-packages/server'), expected);
  assert.deepEqual(await host.client.json('/api/v2/plugin-packages/browser'), []);
}

try {
  report.stage = '原TGZ压缩字节、源双清单与显式七alias身份';
  directory = await mkdtemp(join(tmpdir(), 'deviceforge-android-packages-online-'));
  report.temporary_root = directory;
  context = await prepareArchive({ root, directory, archive, expectedSha256, report });
  report.stage = '已有宿主binary与空数据启动';
  host = await prepareHost({ root, binary, directory: join(directory, 'data'),
    bindingsPath: context.bindingsPath, report, port: await reservePort() });
  await host.ready(); await packages([]); await plugins(host);
  await catalog(host, context, report, '安装前', false);
  assert.deepEqual(await host.client.json('/api/v2/jobs?limit=100'), []);
  report.stage = '公开上传同一原TGZ，不自动加载';
  const installed = await host.client.json('/api/v2/plugin-packages/server?format=tgz', {
    method: 'POST', status: 201, headers: { 'content-type': 'application/gzip' }, body: context.bytes });
  report.install = { package_info: installed, log_id: report.last_request.log_id, status: 201 };
  await packages([installed]); await plugins(host);
  await catalog(host, context, report, '已安装未加载', false);
  assert.deepEqual(await host.client.json('/api/v2/jobs?limit=100'), []);
  await settledRoot(host.plugins); await verifyInstalled(host, context, installed, report);
  report.checks.push({ name: '原TGZ全部普通成员原字节、生成清单及包视图；安装不自动加载', passed: true });
  report.stage = 'HTTP加载、七alias与新贡献';
  const loaded = owner(await host.client.post(`/api/v2/plugins/${pluginId}/load`), undefined, 'loaded');
  report.generations = { first: loaded.generation };
  await plugins(host, loaded); await catalog(host, context, report, '首次加载', true);
  report.stage = '四个无工具Job与实际产物下载';
  await fourJobs(host, directory, report); host.assertRunning(); await verifyUnchanged(context, report, '四Job后');
  report.stage = '已加载部署删除精确拒绝';
  const rejected = await host.client.json(`/api/v2/plugin-packages/server/${pluginId}`, {
    method: 'DELETE', status: 409, code: 'conflict' });
  assert.deepEqual(rejected, { code: 'conflict', message: '操作冲突：服务器插件仍已加载或正在排空，请先完成卸载' });
  report.delete_protection = { status: 409, error: rejected, log_id: report.last_request.log_id };
  await verifyUnchanged(context, report, '拒删后'); await packages([installed]);
  report.stage = 'MCP卸载与四Job历史保留';
  owner(await host.client.tool('deviceforge.unload_plugin', { id: pluginId }), loaded.generation, 'unloaded');
  await plugins(host); await catalog(host, context, report, 'MCP卸载', false);
  await preservedHistory(host, report, 'MCP卸载'); await packages([installed]);
  await verifyUnchanged(context, report, '首次卸载后');
  report.stage = 'MCP新代加载及HTTP再次卸载';
  const reloaded = owner(await host.client.tool('deviceforge.load_plugin', { id: pluginId }), undefined, 'loaded');
  assert.notEqual(reloaded.generation, loaded.generation); report.generations.second = reloaded.generation;
  await plugins(host, reloaded); await catalog(host, context, report, 'MCP新代加载', true);
  await preservedHistory(host, report, '新代加载');
  owner(await host.client.post(`/api/v2/plugins/${pluginId}/unload`), reloaded.generation, 'unloaded');
  await plugins(host); await catalog(host, context, report, '新代卸载', false);
  await preservedHistory(host, report, '新代卸载'); await verifyUnchanged(context, report, '新代装卸后');
  report.stage = '公开部署删除、目录消失及load not_found';
  const removed = await host.client.json(`/api/v2/plugin-packages/server/${pluginId}`, { method: 'DELETE' });
  assert.deepEqual(removed, installed); report.delete = { package_info: removed, log_id: report.last_request.log_id };
  await packages([]); await settledRoot(host.plugins);
  await assert.rejects(lstat(context.deploymentDirectory), { code: 'ENOENT' });
  const missing = await host.client.post(`/api/v2/plugins/${pluginId}/load`, undefined, { status: 404, code: 'not_found' });
  report.load_after_delete = { status: 404, error: missing, log_id: report.last_request.log_id };
  await plugins(host); await catalog(host, context, report, '删除部署后', false);
  await preservedHistory(host, report, '删除部署后');
  report.checks.push({ name: '精确拒删、MCP撤销、不同代重载、再次卸载、公开删除与历史保留', passed: true });
  report.stage = '宿主正常退出、监听释放、实际身份及关联日志落盘';
  await host.shutdown(); await verifyLogs(directory, host, report);
  await host.verifyIdentity(); await verifyArchiveIdentity(context, report);
  report.checks.push({ name: '宿主正常exit0及监听释放、四Job request逐项关联、响应ID含两下载落盘', passed: true });
  // 首业务失败不能被finally覆盖；所有成功资格完成后才标记passed。
  report.stage = '完成'; report.passed = true;
} catch (error) {
  failure(report, error); process.exitCode = 1;
} finally {
  if (host) {
    try { await host.finish(); }
    catch (error) { failure(report, error, '自有宿主收口与监听释放'); process.exitCode = 1; }
  }
  report.shutdown_attempts = report.requests.filter((request) => request.path === '/api/v2/system/shutdown');
  if (directory) {
    try { await retain(directory, report); }
    catch (error) { failure(report, error, '保留证据索引'); report.temporary_retained = directory; process.exitCode = 1; }
  }
  if (!report.passed) process.exitCode = 1;
  await writeReport(root, report);
  console.log(JSON.stringify(report, null, 2));
}
