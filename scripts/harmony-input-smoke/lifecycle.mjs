import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { jobList, preserveHistory, record } from '../harmony-device-smoke/jobs.mjs';
import { owner, plugins } from '../harmony-screenshot-smoke/lifecycle.mjs';
export { owner, plugins };
import { alias, catalog, localId, operation, otherId, pluginId } from './contracts.mjs';
import { action, assertTools, discover, noRelease, normalCase, submitInput } from './cases.mjs';
import {
  advance,
  callCount,
  cases,
  configureHdc,
  prepareInputTool,
  readyCall,
  release,
  setResponse,
} from './fixtures.mjs';

export async function cleanReload(host, deployment, report, options) {
  const old = structuredClone(report.provider);
  owner(
    await host.client.post('/api/v2/plugins/' + pluginId + '/unload'),
    deployment,
    old.generation,
    'unloaded',
  );
  await plugins(host);
  await catalog(host, deployment, report, '确认清理后卸载', false);
  await preserveHistory(host, report, '旧代干净卸载');
  const loaded = owner(
    await host.client.tool('deviceforge.load_plugin', { id: pluginId }),
    deployment,
    undefined,
    'loaded',
  );
  assert.notEqual(loaded.generation, old.generation);
  await plugins(host, loaded);
  await catalog(host, deployment, report, '新代加载', true, loaded);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  await host.client.post('/api/v2/device-actions', action(old), { status: 409, code: 'conflict' });
  await host.client.tool('deviceforge.invoke_device', action(old), 'conflict');
  await discover(host, deployment, report, options, 'second');
  await normalCase(host, deployment, report, options, {
    caseId: 'reloaded-mcp-alias',
    transport: 'mcp',
    point: 'alias',
  });
  await preserveHistory(host, report, '新代执行后旧历史保留');
  owner(
    await host.client.tool('deviceforge.unload_plugin', { id: pluginId }),
    deployment,
    loaded.generation,
    'unloaded',
  );
  await plugins(host);
  await catalog(host, deployment, report, '最终确认清理卸载', false);
  await preserveHistory(host, report, '最终卸载后');
  report.checks.push({
    name: '真实卸载、新代、旧引用拒绝、空目录与旧Job/事件保留',
    passed: true,
    old_generation: old.generation,
    new_generation: loaded.generation,
  });
}

export async function draining(host, deployment, report) {
  const generation = report.provider.generation,
    before = await jobList(host);
  await host.client.post('/api/v2/plugins/' + pluginId + '/unload', undefined, {
    status: 409,
    code: 'cleanup_failed',
  });
  const all = await host.client.json('/api/v2/plugins');
  assert.equal(all.length, 1);
  assert.equal(all[0].state, 'draining');
  assert.equal(all[0].cleanup_failed, true);
  assert.equal(all[0].generation, generation);
  assert.deepEqual(await host.client.tool('deviceforge.list_plugins'), all);
  await catalog(host, deployment, report, '未确认输入资源撤销', false);
  await host.client.post('/api/v2/plugins/' + pluginId + '/load', undefined, {
    status: 409,
    code: 'conflict',
  });
  await host.client.tool('deviceforge.load_plugin', { id: pluginId }, 'conflict');
  for (const [name, input] of [
    [alias('input'), { device_id: localId, action: cases[0].action }],
    [operation('input'), { device_id: localId, input: { action: cases[0].action } }],
  ]) {
    await host.client.post(
      '/api/v2/jobs',
      { operation: name, input },
      { status: 404, code: 'not_found' },
    );
    await host.client.tool(name, input, 'not_found');
  }
  assert.deepEqual(await jobList(host), before);
  await preserveHistory(host, report, '粘性draining后');
  report.draining = {
    generation,
    state: all[0].state,
    cleanup_failed: all[0].cleanup_failed,
    new_jobs_rejected: true,
    same_id_reload_rejected: true,
  };
}

export async function controlStage(host, deployment, report, options, ordinal) {
  const label = 'cancel-' + ordinal;
  const fixture = await prepareInputTool(options, report, label, cases[3]);
  await configureHdc(deployment, fixture, report);
  const entry = await submitInput(host, report, label, {
    selected: cases[3],
    point: ordinal % 2 ? 'capability' : 'alias',
    transport: ordinal % 2 ? 'http' : 'mcp',
  });
  await advance(fixture, ordinal - 1, { probeBinary: options.probeBinary });
  await readyCall(fixture, ordinal, { probeBinary: options.probeBinary });
  const cancelled = await host.client.post('/api/v2/jobs/' + entry.job_id + '/cancel');
  assert.equal(cancelled.status, 'cancelled');
  await record(host, entry, 'cancelled');
  assert.equal(entry.history.error, null);
  assert.equal(entry.history.result, null);
  entry.expected_plugin_code = 'cleanup_failed';
  entry.cleanup_expected = 'failed';
  await assertTools(entry, fixture, ordinal, false);
  await noRelease(fixture, ordinal);
  await draining(host, deployment, report);
  assert.equal(await callCount(fixture), ordinal);
  report.checks.push({
    name: label + ' 唯一终态、真实客户端/插件退出、零后续输入及粘性draining',
    passed: true,
    job_id: entry.job_id,
  });
}

export async function queuedUnload(host, deployment, report, options) {
  const firstFixture = await prepareInputTool(options, report, 'queued-active', cases[3]);
  await configureHdc(deployment, firstFixture, report);
  const first = await submitInput(host, report, 'queued-active', { selected: cases[3] });
  await advance(firstFixture, 2, { probeBinary: options.probeBinary });
  await readyCall(firstFixture, 3, { probeBinary: options.probeBinary });
  const secondFixture = await prepareInputTool(options, report, 'queued-waiter', cases[3]);
  await configureHdc(deployment, secondFixture, report);
  const second = await submitInput(host, report, 'queued-waiter', {
    selected: cases[3],
    point: 'alias',
    transport: 'mcp',
  });
  await delay(100);
  assert.equal(await callCount(secondFixture), 0);
  assert.equal((await host.client.job(first.job_id)).status, 'running');
  const pending = await host.client.job(second.job_id);
  assert.ok(['queued', 'running'].includes(pending.status));
  await host.client.post('/api/v2/plugins/' + pluginId + '/unload', undefined, {
    status: 409,
    code: 'cleanup_failed',
  });
  await record(host, first, 'failed');
  await record(host, second, 'cancelled');
  first.expected_plugin_code = 'cleanup_failed';
  first.cleanup_expected = 'failed';
  second.plugin_invoked = false;
  second.tools = [];
  assert.equal(first.history.result, null);
  assert.equal(first.history.error, '插件资源清理未确认，请检查外部资源后再恢复');
  assert.equal(second.history.result, null);
  assert.equal(second.history.error, null);
  await assertTools(first, firstFixture, 3, false);
  await noRelease(firstFixture, 3);
  assert.equal(await callCount(secondFixture), 0);
  await draining(host, deployment, report);
  assert.equal(await callCount(firstFixture), 3);
  assert.equal(await callCount(secondFixture), 0);
  report.checks.push({
    name: '输入未知时卸载同时撤销排队；不补Enter、排队零插件及零工具，旧历史保留',
    passed: true,
    active_job: first.job_id,
    queued_job: second.job_id,
    queued_status_before_unload: pending.status,
  });
}

export async function sharedLocks(host, deployment, report, options) {
  for (const parallel of [false, true]) {
    const label = parallel ? 'different-device' : 'same-device',
      device = parallel ? otherId : localId;
    const firstFixture = await prepareInputTool(options, report, label + '-first');
    await configureHdc(deployment, firstFixture, report);
    const first = await submitInput(host, report, label + '-first');
    await readyCall(firstFixture, 1, { probeBinary: options.probeBinary });
    const secondFixture = await prepareInputTool(
      options,
      report,
      label + '-second',
      cases[0],
      device,
    );
    await configureHdc(deployment, secondFixture, report);
    const second = await submitInput(host, report, label + '-second', {
      point: 'alias',
      transport: 'mcp',
      device,
    });
    if (parallel) await readyCall(secondFixture, 1, { probeBinary: options.probeBinary });
    else {
      await delay(100);
      assert.equal(await callCount(secondFixture), 0);
    }
    await release(firstFixture, 1);
    await advance(firstFixture, 3, { probeBinary: options.probeBinary, from: 2 });
    await record(host, first);
    if (parallel) {
      await release(secondFixture, 1);
      await advance(secondFixture, 3, { probeBinary: options.probeBinary, from: 2 });
    } else await advance(secondFixture, 3, { probeBinary: options.probeBinary });
    await record(host, second);
    assert.deepEqual(first.history.result, {
      result: { device_id: localId, action: 'tap', dispatched: true },
      artifacts: [],
    });
    assert.deepEqual(second.history.result, { device_id: device, action: 'tap', dispatched: true });
    await assertTools(first, firstFixture, 3);
    await assertTools(second, secondFixture, 3);
    assert.notEqual(
      first.tools[0].process.ready.parent.pid,
      second.tools[0].process.ready.parent.pid,
    );
    report.checks.push({
      name: label + ' 能力/别名跨HTTP/MCP统一设备写锁及独立客户端',
      passed: true,
      first_job: first.job_id,
      second_job: second.job_id,
    });
  }
}

export async function knownClientExit(host, deployment, report, options) {
  const fixture = await prepareInputTool(options, report, 'known-client-exit');
  await setResponse(fixture, 3, 'code', '7');
  await configureHdc(deployment, fixture, report);
  const entry = await submitInput(host, report, 'known-client-exit', { point: 'direct' });
  await advance(fixture, 3, { probeBinary: options.probeBinary });
  await record(host, entry, 'failed');
  entry.expected_plugin_code = 'dependency_failed';
  entry.cleanup_expected = 'complete';
  await assertTools(entry, fixture, 3, false);
  assert.equal(entry.tools[2].process.exit.target.exit_code, 7);
  assert.equal(entry.history.result, null);
  assert.equal(
    entry.history.error,
    '依赖执行失败：工具依赖失败：HDC客户端执行失败，请检查部署配置',
  );
  const loaded = owner(
    (await host.client.json('/api/v2/plugins'))[0],
    deployment,
    report.provider.generation,
    'loaded',
  );
  assert.equal(loaded.cleanup_failed, false);
  owner(
    await host.client.post('/api/v2/plugins/' + pluginId + '/unload'),
    deployment,
    loaded.generation,
    'unloaded',
  );
  await plugins(host);
  await catalog(host, deployment, report, '非零业务失败清理确认后撤销', false);
  report.known_defects = [
    {
      id: 'input-client-exit7-complete-receipt',
      passed: true,
      job_id: entry.job_id,
      expected_plugin_code: 'dependency_failed',
      observed_plugin_code: 'dependency_failed',
      expected_cleanup: 'complete',
      observed_cleanup: 'complete',
      evidence: '三个argv及OS退出7已核对，完整唯一远端帧确认终结；业务保持失败且卸载成功',
    },
  ];
  report.checks.push({
    name: '客户端OS退出7保持业务失败、完整远端帧确认清理且卸载成功',
    passed: true,
    job_id: entry.job_id,
  });
}
