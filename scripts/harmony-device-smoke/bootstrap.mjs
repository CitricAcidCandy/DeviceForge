import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { jobEvents, sharedJob } from '../ordinary-deadline-http/client.mjs';
import { alias, names, operation, pluginId } from './deployment.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export async function catalog(host, deployment, report, phase, available, owner) {
  const operations = await host.client.json('/api/v2/operations');
  assert.deepEqual(await host.client.tool('deviceforge.list_operations'), operations);
  const tools = await host.client.tools();
  for (const name of names) for (const id of [alias(name), operation(name)]) {
    assert.equal(operations.filter((item) => item.id === id).length, available ? 1 : 0, `${phase} ${id}`);
    assert.equal(tools.filter((item) => item === id).length, available ? 1 : 0, `${phase} MCP ${id}`);
  }
  const providers = await host.client.json('/api/v2/device-providers');
  assert.deepEqual(await host.client.tool('deviceforge.list_device_providers'), providers);
  const ours = providers.filter((provider) => provider.id === pluginId);
  assert.equal(ours.length, available ? 1 : 0);
  if (available) {
    assert.equal(ours[0].generation, owner.generation); assert.equal(ours[0].version, deployment.manifest.version);
    assert.deepEqual(ours[0].definition, { ...deployment.manifest.devices, discover_operation: operation('discover'),
      capabilities: deployment.manifest.devices.capabilities.map((item) => ({ ...item, operation: operation(item.operation) })) });
    report.provider = ours[0];
  }
  assert.deepEqual(await host.client.tool('deviceforge.list_devices'), await host.client.json('/api/v2/devices'));
  report.catalog_phases ??= []; report.catalog_phases.push({ phase, available, operations: names.map(operation), aliases: names.map(alias),
    boundary: '仅端点采样，不证明内部注册原子性；九定义能力含七设备/二提供者，设备availability仍七项' });
}

export async function missingHdc(host, report) {
  const before = await host.client.json('/api/v2/jobs?limit=100'); assert.deepEqual(before, []);
  const entry = { case_id: 'host-empty-artifacts-missing-hdc', operation: operation('discover'), input: {}, expected_status: 'failed' };
  const submitted = await host.client.scope({ case_id: entry.case_id, phase: 'submit' }).post('/api/v2/jobs',
    { operation: entry.operation, input: entry.input }, { status: 202 });
  assert.match(submitted.id, uuid); entry.job_id = submitted.id; entry.submit_log_id = report.last_request.log_id;
  assert.match(entry.submit_log_id, uuid); report.jobs.push(entry);
  await poll(() => host.client.job(entry.job_id), (job) => ['succeeded','failed','cancelled'].includes(job.status), '未配HDC真实Job终态', 15000);
  const job = await sharedJob(host.client,entry);
  assert.equal(job.status, 'failed'); assert.equal(job.result, null);
  assert.equal(job.error, '依赖执行失败：工具依赖失败：部署者未配置HDC入口');
  entry.history = job; entry.events = await jobEvents(host.client,entry);
  assert.deepEqual((await host.client.json('/api/v2/jobs?limit=100')).map((item) => item.id), [entry.job_id]);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  assert.deepEqual(await host.client.tool('deviceforge.list_devices'), []);
  entry.artifact_context_boundary = '真实ProcessPlugin公开路径生成空ArtifactContext；精确未配HDC错误证明越过lib空上下文拒绝；未截获stdin原帧';
  entry.direct_plugin_pid_observed = false; entry.hdc_configured = false;
  report.checks.push({ name: '真实宿主空ArtifactContext不误拒，未配HDC精确依赖错误、同Job双端历史及唯一终态', passed: true, job_id: entry.job_id });
}
