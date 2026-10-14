import assert from 'node:assert/strict';
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { poll } from '../device-provider/client.mjs';
import { jobEvents, sharedJob } from '../ordinary-deadline-http/client.mjs';
import { jobList, preserveHistory, record } from '../harmony-device-smoke/jobs.mjs';
import { catalog, jpeg, localId, otherId, pluginId, uuid, alias, operation } from './contracts.mjs';
import { action, discover, normalEntries, submitScreenshot } from './cases.mjs';
import {
  advance,
  callCount,
  configureHdc,
  finishProbe,
  finishTools,
  observeProbe,
  prepareTool,
  readyCall,
  release,
  remoteRoot,
  setPlan,
  stages,
  startProbe,
} from './fixtures.mjs';

export function owner(info, deployment, generation, state) {
  assert.equal(info.id, pluginId);
  assert.equal(info.version, deployment.manifest.version);
  assert.equal(info.state, state);
  assert.equal(info.cleanup_failed, false);
  assert.match(info.generation, uuid);
  if (generation) assert.equal(info.generation, generation);
  return info;
}

export async function plugins(host, expected) {
  const all = await host.client.json('/api/v2/plugins');
  assert.deepEqual(await host.client.tool('deviceforge.list_plugins'), all);
  assert.deepEqual(all, expected ? [expected] : []);
}

export async function histories(host, report, phase) {
  await preserveHistory(host, report, phase);
  for (const entry of report.metadata_jobs) {
    assert.deepEqual(await sharedJob(host.client, entry), entry.history);
    assert.deepEqual(await jobEvents(host.client, entry), entry.events);
  }
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
  await catalog(host, deployment, report, '资源未确认卸载', false);
  await host.client.post('/api/v2/plugins/' + pluginId + '/load', undefined, {
    status: 409,
    code: 'conflict',
  });
  await host.client.tool('deviceforge.load_plugin', { id: pluginId }, 'conflict');
  for (const [name, input] of [
    [alias('screenshot'), { device_id: localId }],
    [operation('screenshot'), { device_id: localId, input: {} }],
  ]) {
    await host.client.post(
      '/api/v2/jobs',
      { operation: name, input },
      { status: 404, code: 'not_found' },
    );
    await host.client.tool(name, input, 'not_found');
  }
  assert.deepEqual(await jobList(host), before);
  await histories(host, report, 'draining后');
  report.draining = {
    generation,
    state: all[0].state,
    cleanup_failed: all[0].cleanup_failed,
    new_jobs_rejected: true,
    same_id_reload_rejected: true,
  };
}

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
  await histories(host, report, '干净卸载后');
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
  await normalEntries(
    host,
    deployment,
    report,
    { ...options, entries: [['mcp', 'alias']] },
    'reloaded',
  );
  await histories(host, report, '新代完成后');
  owner(
    await host.client.tool('deviceforge.unload_plugin', { id: pluginId }),
    deployment,
    loaded.generation,
    'unloaded',
  );
  await plugins(host);
  await catalog(host, deployment, report, '新代确认清理卸载', false);
  await histories(host, report, '最终干净卸载后');
  report.checks.push({
    name: '干净代际重载、旧代拒绝、新代截图与全部已发布历史保留',
    passed: true,
    old_generation: old.generation,
    new_generation: loaded.generation,
  });
}

export async function controlStage(host, deployment, report, options, ordinal, deadline = false) {
  const label = (deadline ? 'deadline-' : 'cancel-') + ordinal;
  const fixture = await prepareTool(options.directory, options.toolBinary, report, { label });
  await configureHdc(deployment, fixture, report);
  const started = performance.now();
  const entry = await submitScreenshot(host, report, label, {
    point: ordinal % 2 ? 'capability' : 'alias',
    transport: ordinal % 2 ? 'http' : 'mcp',
  });
  await advance(fixture, ordinal - 1, { probeBinary: options.probeBinary });
  await readyCall(fixture, ordinal, {
    stage: stages[ordinal - 1],
    probeBinary: options.probeBinary,
  });
  if (deadline) {
    await poll(
      async () => {
        await delay(100);
        return host.client.job(entry.job_id);
      },
      (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status),
      '真实30秒原截止点',
      40000,
    );
    await record(host, entry, 'failed');
    assert.equal(entry.history.error, '插件资源清理未确认，请检查外部资源后再恢复');
    assert.ok(performance.now() - started >= 29000);
  } else {
    const cancelled = await host.client.post('/api/v2/jobs/' + entry.job_id + '/cancel');
    assert.equal(cancelled.status, 'cancelled');
    await record(host, entry, 'cancelled');
    assert.equal(entry.history.error, null);
  }
  entry.expected_plugin_code = 'cleanup_failed';
  entry.cleanup_expected = 'failed';
  assert.equal(entry.history.result, null);
  assert.equal(await callCount(fixture), ordinal);
  entry.tools = await finishTools(fixture);
  assert.equal(entry.tools.at(-1).process.exit.target.state, 'exited');
  assert.equal(entry.tools.at(-1).process.exit.parent.state, 'exited');
  assert.equal(entry.tools.at(-1).process.exit.parent.exit_code, 0);
  await assert.rejects(
    lstat(join(fixture.toolRoot, 'plan-' + String(ordinal).padStart(2, '0'), 'release')),
    { code: 'ENOENT' },
  );
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
  await draining(host, deployment, report);
  await histories(host, report, '控制终态后');
  report.checks.push({
    name: label + ' 原预算、固定工具数、零产物、真实OS退出；历史与清理及draining分层',
    passed: true,
    job_id: entry.job_id,
    elapsed_ms: performance.now() - started,
  });
}

export async function lateResource(host, deployment, report, options, mode) {
  const ordinal = mode === 'reader' ? 4 : 2,
    label = 'late-' + mode;
  const fixture = await prepareTool(options.directory, options.toolBinary, report, { label });
  await setPlan(fixture, ordinal, 'screenshot-worker', mode);
  if (ordinal === 2) await setPlan(fixture, ordinal, 'screenshot-action', 'none');
  await configureHdc(deployment, fixture, report);
  const entry = await submitScreenshot(host, report, label, { point: 'direct', transport: 'mcp' });
  await advance(fixture, ordinal - 1, { probeBinary: options.probeBinary });
  const call = await readyCall(fixture, ordinal, {
    stage: stages[ordinal - 1],
    probeBinary: options.probeBinary,
  });
  assert.deepEqual(await readFile(join(call.directory, 'late-worker.ready')), Buffer.from('1'));
  const workerPid = Number(await readFile(join(call.directory, 'late-worker.pid'), 'utf8'));
  const worker = await startProbe(
    options.probeBinary,
    workerPid,
    join(call.directory, 'worker-process'),
    fixture.copiedTool,
  );
  assert.equal(worker.ready.parent.pid, call.pid);
  fixture.probes.push(worker);
  await host.client.post('/api/v2/jobs/' + entry.job_id + '/cancel');
  await record(host, entry, 'cancelled');
  assert.equal(entry.history.result, null);
  assert.equal(entry.history.error, null);
  entry.expected_plugin_code = 'cleanup_failed';
  entry.cleanup_expected = 'failed';
  entry.tools = await finishTools(fixture);
  assert.equal(entry.tools.at(-1).process.exit.parent.exit_code, 0);
  const observed = await observeProbe(worker);
  assert.equal(observed.parent.state, 'exited');
  assert.equal(observed.target.state, 'running');
  assert.equal(observed.target.wait_status, 258);
  entry.worker_after_plugin_os_exit = observed;
  await draining(host, deployment, report);
  const history = structuredClone(entry.history);
  const trigger = join(call.directory, 'late-worker.trigger');
  await writeFile(trigger + '.tmp', '1', { flag: 'wx' });
  await rename(trigger + '.tmp', trigger);
  entry.worker = await finishProbe(worker);
  assert.equal(entry.worker.exit.target.exit_code, 0);
  assert.equal(await callCount(fixture), ordinal);
  if (mode === 'reader')
    assert.deepEqual(await readFile(join(call.directory, 'late-reader.bytes')), jpeg);
  else {
    assert.deepEqual(await readFile(join(call.directory, 'late-writer.created')), Buffer.from('1'));
    assert.equal(await readFile(join(remoteRoot(fixture), 'owner'), 'utf8'), fixture.token + '\n');
    if (mode === 'writer')
      assert.deepEqual(await readFile(join(remoteRoot(fixture), 'screenshot.jpeg')), jpeg);
    else
      await assert.rejects(lstat(join(remoteRoot(fixture), 'screenshot.jpeg')), { code: 'ENOENT' });
  }
  assert.deepEqual(await sharedJob(host.client, entry), history);
  await histories(host, report, '真实晚到副作用后');
  const state = await host.client.json('/api/v2/plugins');
  assert.equal(state[0].state, 'draining');
  assert.equal(state[0].cleanup_failed, true);
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
  report.checks.push({
    name: label + ' 插件真实OS退出后worker仍Running，晚到真实副作用不改历史或粘性draining',
    passed: true,
    job_id: entry.job_id,
    worker_pid: workerPid,
  });
}

export async function leftoverResource(host, deployment, report, options) {
  const fixture = await prepareTool(options.directory, options.toolBinary, report, {
    label: 'unconfirmed-file',
  });
  await setPlan(fixture, 5, 'screenshot-action', 'clear-with-leftover');
  await setPlan(fixture, 5, 'stdout', '\nDF_CLEAR_REJECTED:{{TOKEN}}\n');
  await configureHdc(deployment, fixture, report);
  const entry = await submitScreenshot(host, report, 'unconfirmed-file', {
    point: 'alias',
    transport: 'http',
  });
  await advance(fixture, 5, { probeBinary: options.probeBinary });
  await record(host, entry, 'failed');
  entry.expected_plugin_code = 'cleanup_failed';
  entry.cleanup_expected = 'failed';
  assert.equal(entry.history.result, null);
  assert.equal(entry.history.error, '插件资源清理未确认，请检查外部资源后再恢复');
  entry.tools = await finishTools(fixture);
  assert.equal(await callCount(fixture), 5);
  assert.deepEqual(
    await readFile(join(remoteRoot(fixture), 'unexpected-file')),
    Buffer.from('fixture-owned'),
  );
  await assert.rejects(lstat(join(remoteRoot(fixture), 'owner')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(remoteRoot(fixture), 'screenshot.jpeg')), { code: 'ENOENT' });
  await draining(host, deployment, report);
  report.checks.push({
    name: '未知文件使rmdir实际失败，零产物发布及同ID重载拒绝',
    passed: true,
    job_id: entry.job_id,
  });
}

export async function queuedUnload(host, deployment, report, options) {
  const activeFixture = await prepareTool(options.directory, options.toolBinary, report, {
    label: 'unknown-active',
  });
  await setPlan(activeFixture, 2, 'screenshot-action', 'none');
  await configureHdc(deployment, activeFixture, report);
  const active = await submitScreenshot(host, report, 'unknown-active', {
    point: 'capability',
    transport: 'http',
  });
  await advance(activeFixture, 1, { probeBinary: options.probeBinary });
  await readyCall(activeFixture, 2, { stage: 'capture', probeBinary: options.probeBinary });
  const queuedFixture = await prepareTool(options.directory, options.toolBinary, report, {
    label: 'unknown-queued',
  });
  await configureHdc(deployment, queuedFixture, report);
  const queued = await submitScreenshot(host, report, 'unknown-queued', {
    point: 'alias',
    transport: 'mcp',
  });
  await delay(100);
  assert.equal(await callCount(queuedFixture), 0);
  assert.equal((await host.client.job(active.job_id)).status, 'running');
  const pending = await host.client.job(queued.job_id);
  assert.ok(['queued', 'running'].includes(pending.status));
  await host.client.post('/api/v2/plugins/' + pluginId + '/unload', undefined, {
    status: 409,
    code: 'cleanup_failed',
  });
  await record(host, active, 'failed');
  await record(host, queued, 'cancelled');
  active.expected_plugin_code = 'cleanup_failed';
  active.cleanup_expected = 'failed';
  queued.plugin_invoked = false;
  queued.tools = [];
  assert.equal(active.history.result, null);
  assert.equal(active.history.error, '插件资源清理未确认，请检查外部资源后再恢复');
  assert.equal(queued.history.result, null);
  assert.equal(queued.history.error, null);
  active.tools = await finishTools(activeFixture);
  assert.equal(await callCount(activeFixture), 2);
  assert.equal(active.tools.at(-1).process.exit.parent.state, 'exited');
  assert.equal(active.tools.at(-1).process.exit.parent.exit_code, 0);
  assert.equal(await callCount(queuedFixture), 0);
  assert.deepEqual(await readdir(activeFixture.scratchRoot), []);
  assert.deepEqual(await readdir(queuedFixture.scratchRoot), []);
  await draining(host, deployment, report);
  assert.equal(await callCount(queuedFixture), 0);
  report.checks.push({
    name: '未知资源在途持同设备写锁、卸载同时取消排队且排队零插件调用及零工具；粘性draining保留历史',
    passed: true,
    active_job: active.job_id,
    queued_job: queued.job_id,
    queued_public_status_before_unload: pending.status,
  });
}

export async function sharedLocks(host, deployment, report, options) {
  for (const parallel of [false, true]) {
    const label = parallel ? 'different-device' : 'same-device';
    const firstFixture = await prepareTool(options.directory, options.toolBinary, report, {
      label: label + '-first',
    });
    await configureHdc(deployment, firstFixture, report);
    const first = await submitScreenshot(host, report, label + '-first', {
      point: 'capability',
      transport: 'http',
    });
    await readyCall(firstFixture, 1, { stage: 'probe', probeBinary: options.probeBinary });
    const secondFixture = await prepareTool(options.directory, options.toolBinary, report, {
      label: label + '-second',
    });
    await configureHdc(deployment, secondFixture, report);
    const device = parallel ? otherId : localId;
    const second = await submitScreenshot(host, report, label + '-second', {
      point: 'alias',
      transport: 'mcp',
      device,
    });
    if (parallel) {
      await readyCall(secondFixture, 1, {
        stage: 'probe',
        device,
        probeBinary: options.probeBinary,
      });
      assert.equal(await callCount(firstFixture), 1);
      assert.equal((await host.client.job(first.job_id)).status, 'running');
      await release(secondFixture, 1);
      await advance(secondFixture, 5, { from: 2, device, probeBinary: options.probeBinary });
      await record(host, second);
      second.tools = await finishTools(secondFixture);
      assert.equal(await callCount(firstFixture), 1);
      assert.equal((await host.client.job(first.job_id)).status, 'running');
    } else {
      await delay(100);
      assert.equal(await callCount(secondFixture), 0);
      assert.equal((await host.client.job(first.job_id)).status, 'running');
    }
    await release(firstFixture, 1);
    await advance(firstFixture, 5, { from: 2, probeBinary: options.probeBinary });
    await record(host, first);
    first.tools = await finishTools(firstFixture);
    if (!parallel) {
      await advance(secondFixture, 5, { probeBinary: options.probeBinary });
      await record(host, second);
      second.tools = await finishTools(secondFixture);
    }
    for (const [entry, fixture] of [
      [first, firstFixture],
      [second, secondFixture],
    ]) {
      assert.equal(entry.history.error, null);
      assert.equal(entry.history.result.result, null);
      assert.equal(entry.history.result.artifacts.length, 1);
      assert.equal(entry.history.result.artifacts[0].filename, 'screenshot.jpeg');
      assert.equal(await callCount(fixture), 5);
      assert.deepEqual(await readdir(fixture.scratchRoot), []);
      await assert.rejects(lstat(remoteRoot(fixture)), { code: 'ENOENT' });
    }
    report.checks.push({
      name: label + ' 两类入口共享写锁/不同设备并行；首HDC就绪后原子切换完整配置',
      passed: true,
      jobs: [first.job_id, second.job_id],
    });
  }
}
