import assert from 'node:assert/strict';
import { catalog } from './bootstrap.mjs';
import { action, noFallback, preciseErrors, submitAction } from './actions.mjs';
import { discover } from './discovery.mjs';
import { keys, localId, finishedTool, setMode, started } from './fixtures.mjs';
import { pluginId } from './deployment.mjs';
import { jobList, preserveHistory, record, uuid } from './jobs.mjs';
import { emptyScratch, installationCopy, installArgv, preserveSource } from './artifacts.mjs';

export function owner(info, deployment, generation, state) {
  assert.equal(info.id, pluginId); assert.equal(info.version, deployment.manifest.version);
  assert.equal(info.state, state); assert.equal(info.cleanup_failed, false); assert.match(info.generation, uuid);
  if (generation !== undefined) assert.equal(info.generation, generation); return info;
}
export async function plugins(host, expected) {
  const all = await host.client.json('/api/v2/plugins'); assert.deepEqual(await host.client.tool('deviceforge.list_plugins'), all);
  assert.deepEqual(all, expected ? [expected] : []);
}
export async function lifecycle(host, deployment, fixture, report) {
  const old = structuredClone(report.provider), before = await keys(fixture); await setMode(fixture, 'hold');
  const held = await submitAction(host, report, '在途MCP卸载HAP安装', action(old, 'app.install', localId, { artifact_id: fixture.installSource.id }), 'mcp');
  const tool = await started(fixture, before, (argv) => installArgv(fixture, argv)); await installationCopy(fixture, tool, { live: true });
  owner(await host.client.tool('deviceforge.unload_plugin', { id: pluginId }), deployment, old.generation, 'unloaded');
  held.tool = await finishedTool(tool, { cancelled: true }); await record(host, held, 'cancelled'); assert.equal(held.history.result, null);
  await installationCopy(fixture, held.tool); await emptyScratch(fixture);
  await plugins(host); await catalog(host, deployment, report, '在途MCP卸载后', false);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []); await noFallback(host, fixture, report, '卸载后');
  await preserveHistory(host, report, '卸载后'); await preserveSource(host, fixture, report, '卸载后');
  await setMode(fixture, 'normal');
  const reloaded = owner(await host.client.post('/api/v2/plugins/' + pluginId + '/load'), deployment, undefined, 'loaded');
  assert.notEqual(reloaded.generation, old.generation); report.generations.second = reloaded.generation;
  await plugins(host, reloaded); await catalog(host, deployment, report, 'HTTP重载', true, reloaded);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  const jobs = await jobList(host), prior = await keys(fixture);
  for (const capability of ['packages', 'app.install', 'app.uninstall']) {
    const input = capability === 'app.install' ? { artifact_id: fixture.installSource.id } : capability === 'app.uninstall' ? { package: 'com.smoke.harmony' } : {};
    const stale = action(old, capability, localId, input);
    await host.client.post('/api/v2/device-actions', stale, { status: 409, code: 'conflict' });
    await host.client.tool('deviceforge.invoke_device', stale, 'conflict');
  }
  await host.client.post('/api/v2/device-providers/' + pluginId + '/refresh', { generation: old.generation }, { status: 409, code: 'conflict' });
  await host.client.tool('deviceforge.refresh_devices', { id: pluginId, generation: old.generation }, 'conflict');
  assert.deepEqual(await jobList(host), jobs); assert.deepEqual(await keys(fixture), prior);
  await preserveHistory(host, report, '重载后'); await preserveSource(host, fixture, report, '重载后');
  await preciseErrors(host, fixture, report, { beforeDiscovery: true });
  await discover(host, deployment, fixture, report, { entry: 'alias', transport: 'mcp', phase: '新代重载' });
  owner(await host.client.post('/api/v2/plugins/' + pluginId + '/unload'), deployment, reloaded.generation, 'unloaded');
  await plugins(host); await catalog(host, deployment, report, '最终HTTP卸载后', false); await noFallback(host, fixture, report, '最终卸载后');
  await preserveHistory(host, report, '最终卸载后'); await preserveSource(host, fixture, report, '最终卸载后');
  report.checks.push({ name: '在途卸载取消、旧代三能力/refresh精确拒绝、重载换代、新发现及历史源HAP保留', passed: true,
    old_generation: old.generation, new_generation: reloaded.generation, held_job_id: held.job_id });
}
