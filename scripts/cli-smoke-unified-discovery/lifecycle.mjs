import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { cleaned, control, events, exited, started } from '../unified-discovery/fixtures.mjs';
import {
  callEntry,
  history,
  jobs,
  keys,
  noDirectory,
  oneDiscovery,
  registrations,
  singleJob,
} from './checks.mjs';

function action(item, provider) {
  return {
    provider_id: item.id,
    generation: provider.generation,
    device_id: item.localId,
    capability: 'device_read',
    version: 1,
    input: {},
  };
}

async function rejectAction(client, input, status, code) {
  await client.post('/api/v2/device-actions', input, { status, code });
  await client.tool('deviceforge.invoke_device', input, code);
}

export async function verifyReload(context, item) {
  const { client, evidence, histories } = context;
  const old = structuredClone(item.provider);
  const label = `${item.platform}_unload_inflight`;
  const before = await jobs(client);
  const beforeKeys = keys(await events(item));
  await control(item, { label, mode: 'hold', state: 'unknown' });
  const submitted = await callEntry(client, item, 'direct', item.protocol === 2 ? 'http' : 'mcp');
  const start = await started(item, label);
  singleJob(before, await jobs(client), item.discoverOperation, submitted.id);
  assert.deepEqual(
    keys(await events(item)).filter((key) => !beforeKeys.includes(key)),
    [`${start.request_id}/${start.pid}`],
  );
  const unloaded = await client.manage(item.id, 'unload', item.protocol === 2 ? 'mcp' : 'http');
  assert.equal(unloaded.state, 'unloaded');
  assert.equal(unloaded.cleanup_failed, false);
  let process;
  if (item.protocol === 3) {
    process = await cleaned(item, label, { cancelled: true, atReturn: true });
  } else {
    await poll(() => exited(start.pid), Boolean, `${item.id} 在途卸载直接PID退出`);
    const records = (await events(item)).filter(
      (record) => record.request_id === start.request_id && record.pid === start.pid,
    );
    const exit = records.find((record) => record.kind === 'process_exit');
    process = {
      label,
      protocol: 2,
      pid: start.pid,
      request_id: start.request_id,
      process_exited: true,
      cleaned: records.some((record) => record.kind === 'cleaned'),
      cancellation_received: records.some((record) => record.kind === 'cancel_received'),
      exit_event: Boolean(exit),
      exit_code: exit?.exit_code ?? null,
      exit_code_observed: Boolean(exit),
      cooperative_confirmation: false,
      cleanup_scope: '仅记录的直接PID已不存在，不推断外部资源或完整进程树清理',
    };
    assert.equal(process.cancellation_received, false, '协议2不能伪造合作取消');
  }
  const cancelled = await client.finished(submitted.id, 'cancelled');
  assert.equal(cancelled.operation, item.discoverOperation);
  const retained = await history(client, submitted.id);
  assert.deepEqual(
    retained.events.map((event) => event.status),
    ['queued', 'running', 'cancelled'],
  );
  histories.set(submitted.id, retained);
  evidence.entries.push({
    providerId: item.id,
    protocol: item.protocol,
    generation: old.generation,
    entry: 'direct-unload',
    transport: item.protocol === 2 ? 'http' : 'mcp',
    label,
    operation: item.discoverOperation,
    jobId: submitted.id,
    requestId: start.request_id,
    pid: start.pid,
    status: 'cancelled',
    jobCountDelta: 1,
    executionCountDelta: 1,
    process,
  });
  await registrations(client, item, false);
  await noDirectory(client, item);

  const rejectedBefore = await jobs(client);
  const rejectedKeys = keys(await events(item));
  const rejectionStart = evidence.rejections.length;
  await client.refresh(old, { status: 404, code: 'not_found' });
  await client.tool(
    'deviceforge.refresh_devices',
    { id: item.id, generation: old.generation },
    'not_found',
  );
  await rejectAction(client, action(item, old), 404, 'not_found');
  for (const operation of [item.discoverOperation, item.alias]) {
    await client.post('/api/v2/jobs', { operation, input: {} }, { status: 404, code: 'not_found' });
    await client.tool(operation, {}, 'not_found');
  }
  assert.deepEqual(await jobs(client), rejectedBefore, '撤销后的拒绝不能创建Job');
  assert.deepEqual(keys(await events(item)), rejectedKeys, '撤销后的拒绝不能执行插件');

  const loaded = await client.manage(item.id, 'load', item.protocol === 2 ? 'mcp' : 'http');
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.cleanup_failed, false);
  assert.notEqual(loaded.generation, old.generation);
  item.provider = await registrations(client, item, true);
  assert.equal(item.provider.generation, loaded.generation);
  await noDirectory(client, item);
  await client.refresh(old, { status: 409, code: 'conflict' });
  await client.tool(
    'deviceforge.refresh_devices',
    { id: item.id, generation: old.generation },
    'conflict',
  );
  await rejectAction(client, action(item, old), 409, 'conflict');
  await rejectAction(client, action(item, item.provider), 409, 'conflict');
  assert.deepEqual(await jobs(client), rejectedBefore, '旧代或尚未观测拒绝不能创建Job');
  assert.deepEqual(keys(await events(item)), rejectedKeys, '旧代或尚未观测拒绝不能执行插件');
  assert.deepEqual(await history(client, submitted.id), retained, '重载不能改绑旧代历史');
  await oneDiscovery(context, item, {
    entry: 'alias',
    transport: item.protocol === 2 ? 'mcp' : 'http',
    label: `${item.platform}_reloaded`,
    rawCase: 'bootloader',
  });
  evidence.reloads.push({
    providerId: item.id,
    protocol: item.protocol,
    oldGeneration: old.generation,
    newGeneration: loaded.generation,
    cancelledJobId: submitted.id,
    process,
    rejections: evidence.rejections.slice(rejectionStart),
  });
}

export async function verifyHistories(context) {
  for (const [id, original] of context.histories) {
    assert.deepEqual(
      await history(context.client, id),
      original,
      '卸载/重载/删除不能改写历史Job及事件',
    );
    context.evidence.history.push({
      jobId: id,
      operation: original.job.operation,
      status: original.job.status,
      eventCount: original.events.length,
      httpMcpEqual: true,
      unchanged: true,
      eventsUnchanged: true,
    });
  }
}
