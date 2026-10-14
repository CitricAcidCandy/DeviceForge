import assert from 'node:assert/strict';
import { catalog } from './bootstrap.mjs';
import { noFallback, action, preciseErrors, submitAction } from './actions.mjs';
import { discover } from './discovery.mjs';
import { keys, localId, finishedTool, setMode, started } from './fixtures.mjs';
import { pluginId } from './deployment.mjs';
import { jobList, preserveHistory, record, uuid } from './jobs.mjs';
import { emptyScratch, preserveArtifacts, screenshotArgv } from './artifacts.mjs';
import { apksArgv, apksCopy } from './apks-fixtures.mjs';

export function owner(info, deployment, generation, state) {
  assert.equal(info.id, pluginId);
  assert.equal(info.version, deployment.manifest.version);
  assert.equal(info.state, state);
  assert.equal(info.cleanup_failed, false);
  assert.match(info.generation, uuid);
  if (generation !== undefined) assert.equal(info.generation, generation);
  return info;
}
export async function plugins(host, expected) {
  const all = await host.client.json('/api/v2/plugins');
  assert.deepEqual(await host.client.tool('deviceforge.list_plugins'), all);
  assert.deepEqual(all, expected ? [expected] : []);
}
async function unloadingCycle(host, deployment, fixture, report, capability) {
  const old = structuredClone(report.provider),
    before = await keys(fixture);
  await setMode(fixture, 'hold');
  const held = await submitAction(
    host,
    report,
    '在途卸载-' + capability,
    action(
      old,
      capability,
      localId,
      capability === 'app.install_apks' ? { artifact_id: fixture.apksSource.id } : {},
    ),
    'mcp',
  );
  const tool = await started(
    fixture,
    before,
    capability === 'app.install_apks' ? (argv) => apksArgv(fixture, argv) : screenshotArgv,
  );
  if (capability === 'app.install_apks')
    await apksCopy(fixture, tool, fixture.apksBytes, { live: true });
  const unloaded = owner(
    await host.client.tool('deviceforge.unload_plugin', { id: pluginId }),
    deployment,
    old.generation,
    'unloaded',
  );
  assert.equal(unloaded.cleanup_failed, false);
  held.tool = await finishedTool(tool, { cancelled: true });
  await record(host, held, 'cancelled');
  if (capability === 'app.install_apks') await apksCopy(fixture, held.tool, fixture.apksBytes);
  assert.equal(held.history.result, null);
  await emptyScratch(fixture);
  await plugins(host);
  await catalog(host, deployment, report, '在途MCP卸载后', false);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  await noFallback(host, fixture, report, '卸载后');
  await preserveHistory(host, report, '卸载后');
  await preserveArtifacts(host, fixture, report, '在途卸载后');
  await setMode(fixture, 'normal');
  const reloaded = owner(
    await host.client.post('/api/v2/plugins/' + pluginId + '/load'),
    deployment,
    undefined,
    'loaded',
  );
  assert.notEqual(reloaded.generation, old.generation);
  report.generations.second = reloaded.generation;
  report.generations.reloads ??= [];
  report.generations.reloads.push({
    capability,
    old: old.generation,
    current: reloaded.generation,
  });
  await plugins(host, reloaded);
  await catalog(host, deployment, report, 'HTTP重载', true, reloaded);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  const jobs = await jobList(host),
    prior = await keys(fixture);
  for (const staleCapability of ['input', 'app.install', 'screenshot', 'app.install_apks']) {
    const stale = action(
      old,
      staleCapability,
      localId,
      staleCapability === 'input'
        ? { action: { kind: 'tap', x: 1, y: 2 } }
        : staleCapability === 'app.install'
          ? { artifact_id: fixture.installSource.id }
          : staleCapability === 'app.install_apks'
            ? { artifact_id: fixture.apksSource.id }
            : {},
    );
    await host.client.post('/api/v2/device-actions', stale, { status: 409, code: 'conflict' });
    await host.client.tool('deviceforge.invoke_device', stale, 'conflict');
  }
  await host.client.post(
    '/api/v2/device-providers/' + pluginId + '/refresh',
    { generation: old.generation },
    { status: 409, code: 'conflict' },
  );
  await host.client.tool(
    'deviceforge.refresh_devices',
    { id: pluginId, generation: old.generation },
    'conflict',
  );
  report.active_case_id = '重载未发现APKS-' + capability;
  const unobserved = action(report.provider, 'app.install_apks', localId, {
    artifact_id: fixture.apksSource.id,
  });
  const observed = host.client.scope({ case_id: report.active_case_id, phase: 'reject' });
  await observed.post('/api/v2/device-actions', unobserved, { status: 409, code: 'conflict' });
  await observed.tool('deviceforge.invoke_device', unobserved, 'conflict');
  assert.deepEqual(await jobList(host), jobs);
  assert.deepEqual(await keys(fixture), prior);
  await preserveHistory(host, report, '不同代重载后');
  await preciseErrors(host, fixture, report, { beforeDiscovery: true });
  await discover(host, deployment, fixture, report, {
    entry: 'alias',
    transport: 'mcp',
    phase: '重载新代-' + capability,
  });
  report.checks.push({
    name:
      capability + '在途卸载、直接PID消失、取消历史、新代重载、四类旧代与新代未观测APKS精确拒绝',
    passed: true,
    old_generation: old.generation,
    new_generation: reloaded.generation,
    held_job_id: held.job_id,
  });
}

export async function lifecycle(host, deployment, fixture, report) {
  for (const capability of ['app.install_apks', 'screenshot'])
    await unloadingCycle(host, deployment, fixture, report, capability);
  const currentGeneration = report.provider.generation;
  owner(
    await host.client.post('/api/v2/plugins/' + pluginId + '/unload'),
    deployment,
    currentGeneration,
    'unloaded',
  );
  await plugins(host);
  await catalog(host, deployment, report, '最终HTTP卸载后', false);
  await noFallback(host, fixture, report, '最终卸载后');
  await preserveHistory(host, report, '最终卸载后');
  await preserveArtifacts(host, fixture, report, '最终卸载后');
  report.checks.push({
    name: '最终卸载十一贡献无内置回退、全部Job/事件/APK/APKS/截图历史保留',
    passed: true,
  });
}
