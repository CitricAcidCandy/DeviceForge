import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { action, events, operation, processEvidence, sourceBytes, started } from './fixtures.mjs';
import { terminal } from './client.mjs';
import { businessInput, writeArtifact } from './artifacts.mjs';
import { discover } from './installation.mjs';

async function pending(context, item, label) {
  const submitted = await context.host.client.action(action(item, businessInput(context, label, 'blocked')));
  const start = await started(item, label);
  await poll(() => events(item), (all) => all.some((event) => event.request_id === start.request_id
    && event.kind === 'copy_verified'), `${label} 已实际读取宿主副本`, 10000);
  assert.equal((await context.host.client.job(submitted.id)).status, 'running');
  return submitted;
}

async function preserved(context) {
  for (const [id, previous] of context.history) {
    assert.deepEqual(await terminal(context.host.client, id, previous.status), previous, '热装卸不得改写历史任务');
    for (const artifact of previous.result?.artifacts ?? []) await context.host.download(artifact, sourceBytes);
  }
}

async function hidden(client, item) {
  assert.ok(!(await client.json('/api/v2/device-providers')).some((provider) => provider.id === item.id));
  assert.ok(!(await client.json('/api/v2/devices')).some((directory) => directory.provider.id === item.id));
  assert.deepEqual(await client.tool('deviceforge.list_devices'), await client.json('/api/v2/devices'));
  const prefix = `plugin.${item.id}.`;
  assert.ok(!(await client.json('/api/v2/operations')).some((entry) => entry.id.startsWith(prefix)));
  assert.ok(!(await client.tools()).some((name) => name.startsWith(prefix)));
}

export async function verifyLifecycle(context) {
  const { host, fixtures, report, history } = context;
  const { client } = host;
  for (const item of fixtures) {
    const label = `cancel-explicit-v${item.protocol}`;
    const active = await pending(context, item, label);
    assert.equal((await client.tool('deviceforge.cancel_job', { id: active.id })).status, 'cancelled');
    const cancelled = await terminal(client, active.id, 'cancelled');
    assert.equal(cancelled.result, null);
    const evidence = await processEvidence(item, label, { cooperative: item.protocol === 3 });
    history.set(active.id, cancelled);
    report.checks.push({ name: `协议 ${item.protocol} 副本读取后的 MCP 显式取消与真实 PID 退出`,
      passed: true, job_id: active.id, evidence,
      boundary: item.protocol === 3 ? '已收到取消帧、显式清理、EOF 与零退出' : '只证明进程停止，不证明外部资源合作清理' });
  }

  for (const item of fixtures) {
    const old = item.provider;
    const label = `cancel-unload-v${item.protocol}`;
    const active = await pending(context, item, label);
    const detached = await client.manage(item.id, 'unload', item.protocol === 2 ? 'http' : 'mcp');
    assert.equal(detached.state, 'unloaded'); assert.equal(detached.cleanup_failed, false);
    assert.equal(detached.generation, old.generation);
    const evidence = await processEvidence(item, label, { atReturn: true, cooperative: item.protocol === 3 });
    history.set(active.id, await terminal(client, active.id, 'cancelled'));
    await hidden(client, item);
    const loaded = await client.manage(item.id, 'load', item.protocol === 2 ? 'mcp' : 'http');
    assert.equal(loaded.state, 'loaded'); assert.equal(loaded.cleanup_failed, false);
    item.provider = (await client.json('/api/v2/device-providers')).find((provider) => provider.id === item.id);
    assert.ok(item.provider); assert.notEqual(item.provider.generation, old.generation);
    const oldAction = action(item, businessInput(context, `stale-v${item.protocol}`), 'device.write', old);
    await client.post('/api/v2/device-actions', oldAction, { status: 409, code: 'conflict' });
    await client.tool('deviceforge.invoke_device', oldAction, 'conflict');
    await client.refresh(old, { status: 409, code: 'conflict' });
    await client.tool('deviceforge.refresh_devices', { id: old.id, generation: old.generation }, 'conflict');
    assert.ok(!(await client.json('/api/v2/devices')).some((directory) => directory.provider.id === item.id),
      '重载不能复活旧目录');
    await client.post('/api/v2/device-actions', action(item, businessInput(context, `unobserved-v${item.protocol}`)),
      { status: 409, code: 'conflict' });
    await discover(client, item, 'mcp');
    await writeArtifact(context, item, 'http', `reloaded-v${item.protocol}`);
    await preserved(context);
    host.assertRunning();
    report.checks.push({ name: `协议 ${item.protocol} 在途卸载、返回时退出、重载与旧引用精确拒绝`, passed: true,
      old_generation: old.generation, new_generation: item.provider.generation,
      status: 409, code: 'conflict', cancelled_job_id: active.id, evidence });
  }

  for (const item of fixtures) {
    await client.manage(item.id, 'unload'); await hidden(client, item);
    const deleted = await client.json(`/api/v2/plugin-packages/server/${item.id}`, { method: 'DELETE' });
    assert.equal(deleted.id, item.id);
  }
  const providers = await client.json('/api/v2/device-providers');
  const directories = await client.json('/api/v2/devices');
  const packages = await client.json('/api/v2/plugin-packages/server');
  assert.deepEqual(providers, context.baseline.providers);
  assert.deepEqual(packages, context.baseline.packages);
  assert.ok(!directories.some((directory) => fixtures.some((item) => item.id === directory.provider.id)));
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), providers);
  assert.deepEqual(await client.tool('deviceforge.list_devices'), directories);
  const jobs = await client.json('/api/v2/jobs?limit=100');
  assert.ok(!jobs.some((job) => fixtures.some((item) => job.operation.startsWith(`plugin.${item.id}.`))
    && ['queued', 'running'].includes(job.status)), '没有本次残留活动任务');
  await preserved(context);
  report.history_jobs = [...history.keys()];
  report.checks.push({ name: '部署删除后成功/失败/取消历史及已发布产物仍保留', passed: true });
}
