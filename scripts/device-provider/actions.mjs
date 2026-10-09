import assert from 'node:assert/strict';
import { actionInput } from './discovery.mjs';
import { cleaned, events, localId, offlineId, operation, otherId, release, started } from './fixtures.mjs';

async function complete(client, item, task, label) {
  const job = await client.finished(task.id);
  assert.equal(job.result.result.provider_id, item.id);
  assert.equal(job.result.result.label, label);
  assert.equal(job.result.result.synthetic_device, true);
  assert.deepEqual(job.result.artifacts, []);
  await cleaned(item, label);
  return job;
}

function ordered(all, beforeLabel, afterLabel) {
  const end = all.findIndex((event) => event.kind === 'cleaned' && event.label === beforeLabel);
  const start = all.findIndex((event) => event.kind === 'started' && event.label === afterLabel);
  assert.ok(end >= 0 && start > end, `实际进程事件必须串行：${beforeLabel} → ${afterLabel}`);
}

export async function verifyActions({ client, first, second, report }) {
  const completed = [];
  for (const [capability, deviceId, transport] of [['provider_read', null, 'http'], ['provider_write', null, 'mcp'],
    ['device_read', localId, 'mcp'], ['device_write', localId, 'http']]) {
    const label = `basic-${capability}`;
    const task = await client.action(actionInput(first.provider, capability, deviceId, { label }), transport);
    const job = await complete(client, first, task, label);
    assert.equal(job.operation, operation(first, capability));
    assert.equal(job.result.result.device_id, deviceId);
    completed.push(job.id);
  }
  report.history_jobs = completed;
  report.checks.push({ name: '提供者/设备范围与读/写能力复用 HTTP/MCP 共享任务', passed: true, jobs: completed });
  const base = actionInput(first.provider, 'device_read', localId, { label: 'rejected' });
  const failures = [
    ['未知提供者', { ...base, provider_id: 'not_installed_provider' }, 404, 'not_found'],
    ['未知能力', { ...base, capability: 'undeclared' }, 404, 'not_found'],
    ['能力版本精确匹配', { ...base, version: 2 }, 404, 'not_found'],
    ['未知设备', { ...base, device_id: 'not_discovered' }, 404, 'not_found'],
    ['离线设备', { ...base, device_id: offlineId }, 409, 'conflict'],
    ['明确不可用能力', { ...base, capability: 'disabled' }, 409, 'conflict'],
    ['缺少能力可用观测', { ...base, capability: 'missing' }, 409, 'conflict'],
    ['过期提供者代际', { ...base, generation: '00000000-0000-4000-8000-000000000000' }, 409, 'conflict'],
    ['非对象能力输入', { ...base, input: [] }, 400, 'invalid_input'],
    ['非法零版本', { ...base, version: 0 }, 400, 'invalid_input'],
    ['缺少必填字段', { provider_id: first.id }, 400, 'invalid_input'],
  ];
  for (const [name, request, status, code] of failures) {
    await client.post('/api/v2/device-actions', request, { status, code });
    await client.tool('deviceforge.invoke_device', request, code);
    report.checks.push({ name, passed: true, status, code });
  }
  await client.json('/api/v2/device-actions', { method: 'POST', body: '{', status: 400, code: 'invalid_input' });
  assert.ok(!(await events(first)).some((event) => event.label === 'rejected'), '拒绝请求不能启动能力进程');

  // 门闩让第一个真实任务保持运行，避免仅用耗时猜测设备写互斥。
  const firstWrite = await client.action(actionInput(first.provider, 'device_write', localId,
    { label: 'serial-first', gate: true, duration_ms: 12000 }));
  await started(first, 'serial-first');
  const directWrite = await client.post('/api/v2/jobs', { operation: operation(first, 'device_write'),
    input: { device_id: localId, input: { label: 'serial-direct' } } }, { status: 202 });
  const otherWrite = await client.action(actionInput(first.provider, 'device_write', otherId,
    { label: 'parallel-other', gate: true, duration_ms: 12000 }), 'mcp');
  await started(first, 'parallel-other');
  assert.ok(!(await events(first)).some((event) => event.kind === 'started' && event.label === 'serial-direct'));
  await release(first, 'serial-first'); await release(first, 'parallel-other');
  for (const [task, label] of [[firstWrite, 'serial-first'], [directWrite, 'serial-direct'], [otherWrite, 'parallel-other']]) {
    await complete(client, first, task, label);
  }
  const writes = await events(first);
  ordered(writes, 'serial-first', 'serial-direct');
  assert.ok(writes.findIndex((event) => event.kind === 'started' && event.label === 'parallel-other')
    < writes.findIndex((event) => event.kind === 'cleaned' && event.label === 'serial-first'));
  report.checks.push({ name: '同设备写串行、直接 jobs 不绕过、不同设备写并行', passed: true,
    jobs: [firstWrite.id, directWrite.id, otherWrite.id] });

  const reads = [];
  for (const label of ['read-first', 'read-second']) {
    const task = await client.action(actionInput(first.provider, 'device_read', localId,
      { label, gate: true, duration_ms: 12000 }), label === 'read-first' ? 'http' : 'mcp');
    await started(first, label); reads.push({ task, label });
  }
  for (const { label } of reads) await release(first, label);
  for (const { task, label } of reads) await complete(client, first, task, label);
  report.checks.push({ name: '同设备读彼此并行', passed: true, jobs: reads.map(({ task }) => task.id) });

  const barrier = await client.action(actionInput(first.provider, 'provider_write', null,
    { label: 'provider-barrier', gate: true, duration_ms: 12000 }));
  await started(first, 'provider-barrier');
  const blockedRead = await client.action(actionInput(first.provider, 'device_read', localId, { label: 'blocked-read' }), 'mcp');
  const blockedWrite = await client.post('/api/v2/jobs', { operation: operation(first, 'device_write'),
    input: { device_id: otherId, input: { label: 'blocked-direct-write' } } }, { status: 202 });
  const crossProvider = await client.action(actionInput(second.provider, 'device_write', localId,
    { label: 'cross-provider', gate: true, duration_ms: 12000 }));
  await started(second, 'cross-provider');
  assert.ok(!(await events(first)).some((event) => event.kind === 'started'
    && ['blocked-read', 'blocked-direct-write'].includes(event.label)), '提供者写屏障必须同时阻止设备读和写');
  await release(first, 'provider-barrier'); await release(second, 'cross-provider');
  for (const [task, label] of [[barrier, 'provider-barrier'], [blockedRead, 'blocked-read'], [blockedWrite, 'blocked-direct-write']]) {
    await complete(client, first, task, label);
  }
  await complete(client, second, crossProvider, 'cross-provider');
  const barriers = await events(first);
  ordered(barriers, 'provider-barrier', 'blocked-read');
  ordered(barriers, 'provider-barrier', 'blocked-direct-write');
  report.checks.push({ name: '提供者写屏障阻止设备读/写、直接 jobs 不绕过、跨提供者并行', passed: true,
    jobs: [barrier.id, blockedRead.id, blockedWrite.id, crossProvider.id] });

  const cancellable = await client.action(actionInput(first.provider, 'device_write', localId,
    { label: 'explicit-cancel', gate: true, duration_ms: 12000 }), 'mcp');
  await started(first, 'explicit-cancel');
  assert.equal((await client.tool('deviceforge.cancel_job', { id: cancellable.id })).status, 'cancelled');
  await client.finished(cancellable.id, 'cancelled');
  const evidence = await cleaned(first, 'explicit-cancel', { cancelled: true });
  report.checks.push({ name: 'MCP 显式取消能力任务、真实合作清理和进程退出', passed: true,
    job_id: cancellable.id, evidence });
}
