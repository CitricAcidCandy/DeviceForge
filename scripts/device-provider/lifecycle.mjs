import assert from 'node:assert/strict';
import { poll } from './client.mjs';
import { actionInput, assertNoDirectory, verifyDirectory } from './discovery.mjs';
import { cleaned, control, localId, operation, started } from './fixtures.mjs';

async function hidden(client, item) {
  assert.ok(!(await client.json('/api/v2/device-providers')).some((provider) => provider.id === item.id));
  assert.ok(!(await client.json('/api/v2/devices')).some((directory) => directory.provider.id === item.id));
  assert.deepEqual(await client.tool('deviceforge.list_devices'), await client.json('/api/v2/devices'));
  const prefix = `plugin.${item.id}.`;
  assert.ok(!(await client.json('/api/v2/operations')).some((entry) => entry.id.startsWith(prefix)));
  assert.ok(!(await client.tools()).some((name) => name.startsWith(prefix)));
  const input = { device_id: localId, input: { label: 'unloaded' } };
  await client.post('/api/v2/jobs', { operation: operation(item, 'device_write'), input }, { status: 404, code: 'not_found' });
  await client.tool(operation(item, 'device_write'), input, 'not_found');
}

async function reload(client, item, old, label) {
  const loaded = await client.manage(item.id, 'load', 'mcp');
  assert.equal(loaded.state, 'loaded'); assert.equal(loaded.cleanup_failed, false);
  const provider = (await client.json('/api/v2/device-providers')).find((value) => value.id === item.id);
  assert.ok(provider); assert.notEqual(provider.generation, old.generation);
  assert.equal(provider.generation, loaded.generation);
  await client.refresh(old, { status: 409, code: 'conflict' });
  await client.tool('deviceforge.refresh_devices', { id: old.id, generation: old.generation }, 'conflict');
  const oldAction = actionInput(old, 'device_write', localId, { label: 'old-generation' });
  await client.post('/api/v2/device-actions', oldAction, { status: 409, code: 'conflict' });
  await client.tool('deviceforge.invoke_device', oldAction, 'conflict');
  assert.ok(!(await client.json('/api/v2/devices')).some((directory) => directory.provider.id === item.id),
    '重载后不能隐式复活旧目录');
  const notObserved = actionInput(provider, 'device_read', localId, { label: 'not-observed-after-reload' });
  await client.post('/api/v2/device-actions', notObserved, { status: 409, code: 'conflict' });
  await control(item, 'valid', label);
  const directory = await client.refresh(provider);
  await verifyDirectory(client, provider, directory);
  item.provider = provider; item.directorySnapshot = directory;
  return provider;
}

async function pendingDiscovery(client, item, label) {
  await control(item, 'blocked', label);
  // 先捕获完成/拒绝，避免卸载期间尚未 await 的请求产生未处理拒绝。
  const response = client.call(`/api/v2/device-providers/${item.id}/refresh`, { method: 'POST',
    body: JSON.stringify({ generation: item.provider.generation }) }).then((value) => ({ value }), (error) => ({ error }));
  await started(item, label);
  await assertNoDirectory(client, item.provider);
  const job = await poll(() => client.json('/api/v2/jobs?limit=100'),
    (all) => all.some((task) => task.operation === operation(item, 'discover') && task.status === 'running'), '发现共享任务');
  const task = job.find((value) => value.operation === operation(item, 'discover') && value.status === 'running');
  return { response, task };
}

async function rejectedRefresh(response, code) {
  const reply = await response;
  if (reply.error) throw reply.error;
  assert.equal(reply.value.status, 409);
  assert.equal(reply.value.body.error.code, code);
}

export async function verifyLifecycle({ client, first, second, report }) {
  const old = first.provider;
  const active = await client.action(actionInput(old, 'device_write', localId,
    { label: 'unload-active', gate: true, duration_ms: 12000 }));
  await started(first, 'unload-active');
  const unloaded = await client.manage(first.id, 'unload');
  const evidence = await cleaned(first, 'unload-active', { cancelled: true, atReturn: true });
  assert.equal(unloaded.state, 'unloaded'); assert.equal(unloaded.cleanup_failed, false);
  assert.equal(unloaded.generation, old.generation);
  await client.finished(active.id, 'cancelled'); await hidden(client, first);
  assert.deepEqual((await client.json('/api/v2/device-providers')).find((provider) => provider.id === second.id), second.provider);
  await client.refresh(old, { status: 404, code: 'not_found' });
  await reload(client, first, old, 'reload-after-action');
  for (const id of report.history_jobs) await client.finished(id);
  await client.finished(active.id, 'cancelled');
  report.checks.push({ name: '卸载能力任务、返回时清理/退出、撤销目录/贡献、重载新代与历史保留', passed: true,
    old_generation: old.generation, new_generation: first.provider.generation, job_id: active.id, evidence });

  const explicit = await pendingDiscovery(client, first, 'cancel-discovery');
  assert.equal((await client.post(`/api/v2/jobs/${explicit.task.id}/cancel`)).status, 'cancelled');
  await rejectedRefresh(explicit.response, 'cancelled');
  await client.finished(explicit.task.id, 'cancelled');
  const discoveryEvidence = await cleaned(first, 'cancel-discovery', { cancelled: true });
  await assertNoDirectory(client, first.provider);
  await control(first, 'valid', 'recover-cancelled-discovery');
  first.directorySnapshot = await client.refresh(first.provider);
  await verifyDirectory(client, first.provider, first.directorySnapshot);
  report.checks.push({ name: '显式取消发现返回 409 cancelled、无活动发现任务与清理退出', passed: true,
    job_id: explicit.task.id, evidence: discoveryEvidence });

  const generation = first.provider;
  const refreshing = await pendingDiscovery(client, first, 'unload-discovery');
  const detached = await client.manage(first.id, 'unload', 'mcp');
  const refreshEvidence = await cleaned(first, 'unload-discovery', { cancelled: true, atReturn: true });
  assert.equal(detached.cleanup_failed, false);
  // owner 撤销是当前性冲突；显式用户取消才返回 cancelled。
  await rejectedRefresh(refreshing.response, 'conflict');
  await client.finished(refreshing.task.id, 'cancelled');
  await hidden(client, first);
  await reload(client, first, generation, 'reload-after-discovery');
  assert.notEqual(first.directorySnapshot.discovery_job_id, refreshing.task.id);
  const latest = await client.json('/api/v2/devices');
  assert.ok(latest.every((directory) => directory.provider.id !== first.id
    || directory.provider.generation === first.provider.generation));
  await client.finished(refreshing.task.id, 'cancelled');
  report.checks.push({ name: '卸载在途发现、禁止旧代目录复活与再次重载', passed: true,
    old_generation: generation.generation, new_generation: first.provider.generation,
    job_id: refreshing.task.id, evidence: refreshEvidence });
  for (const item of [first, second]) {
    await client.manage(item.id, 'unload');
    const deleted = await client.json(`/api/v2/plugin-packages/server/${item.id}`, { method: 'DELETE' });
    assert.equal(deleted.id, item.id);
  }
  assert.deepEqual(await client.json('/api/v2/device-providers'), []);
  assert.deepEqual(await client.json('/api/v2/devices'), []);
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), []);
  assert.deepEqual(await client.tool('deviceforge.list_devices'), []);
  assert.deepEqual(await client.json('/api/v2/plugin-packages/server'), []);
  const remaining = await client.json('/api/v2/jobs?limit=100');
  assert.ok(!remaining.some((job) => job.operation.startsWith('plugin.provider_smoke_') && ['queued', 'running'].includes(job.status)));
  for (const id of report.history_jobs) await client.finished(id);
}
