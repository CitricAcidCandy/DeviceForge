import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { assertDirectory, assertLegacyArray } from '../unified-discovery-smoke/observations.mjs';
import { alias, operation, pluginId } from './deployment.mjs';
import { directoryDevices, finishedTool, keys, observations, rawDevices, setMode } from './fixtures.mjs';
import { jobList, record, submit, uuid } from './jobs.mjs';

export async function discover(host, deployment, fixture, report, { entry = 'refresh', transport = 'http', phase = '首次代' } = {}) {
  const provider = report.provider, caseId = phase + '-' + entry + '-' + transport;
  report.active_case_id = caseId;
  const beforeJobs = await jobList(host), previous = new Set(beforeJobs.map((item) => item.id)), before = await keys(fixture);
  const observed = host.client.scope({ case_id: caseId, phase: 'submit' });
  let task, returned;
  if (entry === 'refresh') {
    returned = transport === 'http'
      ? await observed.post('/api/v2/device-providers/' + pluginId + '/refresh', { generation: provider.generation })
      : await observed.tool('deviceforge.refresh_devices', { id: pluginId, generation: provider.generation });
    assert.match(returned.discovery_job_id, uuid);
    task = { case_id: caseId, operation: operation('discover'), input: {}, transport,
      job_id: returned.discovery_job_id, submit_log_id: report.last_request.log_id, expected_status: 'succeeded' };
    report.jobs.push(task);
  } else task = await submit(host, report, caseId, entry === 'alias' ? alias('discover') : operation('discover'), {}, transport);
  assert.match(task.submit_log_id, uuid);
  const job = await record(host, task);
  assert.deepEqual((await jobList(host)).filter((item) => !previous.has(item.id)).map((item) => item.id), [task.job_id]);
  const directories = await poll(() => host.client.json('/api/v2/devices'),
    (all) => all.some((directory) => directory.provider.id === pluginId && directory.discovery_job_id === task.job_id), caseId);
  assert.deepEqual(await host.client.tool('deviceforge.list_devices'), directories);
  const directory = directories.find((item) => item.provider.id === pluginId);
  assertDirectory(directory, provider, directoryDevices, task.job_id);
  if (entry === 'refresh') assert.deepEqual(returned, directory);
  if (entry === 'alias') assertLegacyArray(job.result, directoryDevices, 'harmony');
  else assert.deepEqual(job.result, { result: rawDevices, artifacts: [] });
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  assert.equal(added.length, 1); assert.deepEqual(added[0].ready.argv, ['list', 'targets']);
  task.tool = await finishedTool(added[0]); task.directory = directory;
  report.checks.push({ name: '三类发现各一Job/一工具 ' + caseId, passed: true, job_id: task.job_id,
    boundary: '本次串行公开采样，非内部注册或提交原子性证明' }); return task;
}

export async function discoveryEntries(host, deployment, fixture, report) {
  for (const entry of ['refresh', 'direct', 'alias']) for (const transport of ['http', 'mcp']) {
    await discover(host, deployment, fixture, report, { entry, transport });
  }
}

export async function malformedDiscovery(host, deployment, fixture, report) {
  await setMode(fixture, 'duplicate');
  const before = await keys(fixture), beforeJobs = await jobList(host), ids = new Set(beforeJobs.map((item) => item.id));
  const task = await submit(host, report, '重复serial整份发现失败', operation('discover'), {}, 'mcp');
  const job = await record(host, task, 'failed');
  assert.equal(job.result, null);
  assert.equal(job.error, '依赖执行失败：工具依赖失败：HDC发现条目无效、重复或超过128条');
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  assert.equal(added.length, 1); assert.deepEqual(added[0].ready.argv, ['list', 'targets']);
  task.tool = await finishedTool(added[0]);
  assert.deepEqual((await jobList(host)).filter((item) => !ids.has(item.id)).map((item) => item.id), [task.job_id]);
  const directories = await poll(() => host.client.json('/api/v2/devices'),
    (all) => !all.some((directory) => directory.provider.id === pluginId), '坏发现撤销旧目录');
  assert.deepEqual(await host.client.tool('deviceforge.list_devices'), directories);
  await setMode(fixture, 'normal'); await discover(host, deployment, fixture, report, { phase: '坏发现恢复' });
  report.checks.push({ name: '重复serial精确失败、一Job/一工具、整份目录撤销与重新发现恢复', passed: true, job_id: task.job_id });
}
