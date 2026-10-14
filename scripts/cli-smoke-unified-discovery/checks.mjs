import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { cleaned, control, events, rawCases } from '../unified-discovery/fixtures.mjs';

export async function jobs(client) {
  const result = await client.json('/api/v2/jobs?limit=200');
  assert.ok(
    Array.isArray(result) && result.length < 200,
    '不能用截断任务列表证明一次调用只创建一个Job',
  );
  return result;
}

export const keys = (records) =>
  records
    .filter((record) => record.kind === 'started')
    .map((record) => `${record.request_id}/${record.pid}`)
    .sort();

export function singleJob(before, after, operation, id) {
  const previous = new Set(before.map((job) => job.id));
  const added = after.filter((job) => !previous.has(job.id));
  assert.equal(added.length, 1, '三入口只能创建一个共享Job');
  if (id !== undefined) assert.equal(added[0].id, id);
  assert.equal(added[0].operation, operation);
  assert.deepEqual(added[0].input, {});
  return added[0];
}

export async function history(client, id) {
  const job = await client.job(id);
  assert.deepEqual(await client.tool('deviceforge.get_job', { id }), job);
  const events = await client.json(`/api/v2/jobs/${id}/events`);
  assert.deepEqual(await client.tool('deviceforge.job_events', { id }), events);
  return { job, events };
}

export async function callEntry(client, item, entry, transport) {
  if (entry === 'refresh')
    return transport === 'http'
      ? client.refresh(item.provider)
      : client.tool('deviceforge.refresh_devices', {
          id: item.id,
          generation: item.provider.generation,
        });
  const operation = entry === 'alias' ? item.alias : item.discoverOperation;
  return transport === 'http'
    ? client.post('/api/v2/jobs', { operation, input: {} }, { status: 202 })
    : client.tool(operation, {});
}

export async function currentDirectory(client, item, id) {
  const all = await poll(
    () => client.json('/api/v2/devices'),
    (directories) =>
      directories.some(
        (directory) => directory.provider.id === item.id && directory.discovery_job_id === id,
      ),
    `npx ${item.id} 本Job目录接受`,
  );
  assert.deepEqual(await client.tool('deviceforge.list_devices'), all);
  return all.find((directory) => directory.provider.id === item.id);
}

export async function noDirectory(client, item) {
  const all = await client.json('/api/v2/devices');
  assert.deepEqual(await client.tool('deviceforge.list_devices'), all);
  assert.ok(!all.some((directory) => directory.provider.id === item.id));
}

export async function registrations(client, item, present) {
  const all = await client.json('/api/v2/device-providers');
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), all);
  const provider = all.find((entry) => entry.id === item.id);
  assert.equal(Boolean(provider), present);
  const operationIds = (await client.json('/api/v2/operations')).map((entry) => entry.id);
  const toolIds = await client.tools();
  for (const name of [item.discoverOperation, item.alias]) {
    assert.equal(operationIds.includes(name), present, `HTTP贡献 ${name}`);
    assert.equal(toolIds.includes(name), present, `MCP贡献 ${name}`);
  }
  if (present) {
    assert.equal(provider.definition.api_version, 3);
    assert.equal(provider.definition.platform, item.platform);
    assert.equal(provider.definition.discover_operation, item.discoverOperation);
  }
  return provider;
}

function assertObservation(item, directory, job, entry, rawState) {
  assert.deepEqual(directory.provider, item.provider);
  assert.equal(directory.discovery_job_id, job.id);
  assert.ok(Number.isSafeInteger(directory.observed_at) && directory.observed_at > 0);
  assert.equal(directory.devices.length, 1);
  const device = directory.devices[0];
  assert.deepEqual(device.reference, {
    provider_id: item.id,
    generation: item.provider.generation,
    local_id: item.localId,
  });
  assert.equal(device.state, 'unknown', '原文不能猜测或替换归一化状态');
  assert.equal(device.raw_state, rawState);
  assert.deepEqual(Buffer.from(device.raw_state, 'utf8'), Buffer.from(rawState, 'utf8'));
  assert.equal(device.model, null);
  const availability = [
    { id: 'device_read', version: 1, available: true },
    { id: 'device_write', version: 1, available: true },
  ];
  assert.deepEqual(
    device.capabilities,
    availability.map((capability) => ({ ...capability, reason: null })),
  );
  if (entry === 'alias') {
    assert.deepEqual(job.result, [
      { id: item.localId, platform: item.platform, state: rawState, model: null },
    ]);
    assert.deepEqual(Object.keys(job.result[0]).sort(), ['id', 'model', 'platform', 'state']);
  } else {
    assert.deepEqual(Object.keys(job.result).sort(), ['artifacts', 'result']);
    assert.deepEqual(job.result.artifacts, []);
    assert.deepEqual(job.result.result, [
      { id: item.localId, state: 'unknown', raw_state: rawState, capabilities: availability },
    ]);
  }
}

export async function oneDiscovery(
  context,
  item,
  { entry, transport, label, rawCase = 'valid', rawState },
) {
  const { client, evidence, histories } = context;
  const before = await jobs(client);
  const beforeKeys = keys(await events(item));
  const previousLogs = new Set(client.logIds);
  const expectedRaw = rawState === undefined ? rawCases[rawCase] : rawState;
  assert.equal(typeof expectedRaw, 'string', '成功旧profile需要真实合法原文');
  await control(item, {
    label,
    rawCase,
    ...(rawState !== undefined ? { rawState } : {}),
    state: 'unknown',
  });
  const returned = await callEntry(client, item, entry, transport);
  const id = entry === 'refresh' ? returned.discovery_job_id : returned.id;
  const job = await client.finished(id);
  const directory = entry === 'refresh' ? returned : await currentDirectory(client, item, id);
  assertObservation(item, directory, job, entry, expectedRaw);
  assert.deepEqual(await currentDirectory(client, item, id), directory);
  const operation = entry === 'alias' ? item.alias : item.discoverOperation;
  singleJob(before, await jobs(client), operation, id);
  const process = await cleaned(item, label);
  const afterKeys = keys(await events(item));
  const added = afterKeys.filter((key) => !beforeKeys.includes(key));
  assert.deepEqual(added, [`${process.request_id}/${process.pid}`], '一个Job必须只有一次真实执行');
  const retained = await history(client, id);
  assert.deepEqual(
    retained.events.map((event) => event.status),
    ['queued', 'running', 'succeeded'],
  );
  histories.set(id, retained);
  evidence.entries.push({
    providerId: item.id,
    generation: item.provider.generation,
    protocol: item.protocol,
    entry,
    transport,
    operation,
    label,
    jobId: id,
    requestId: process.request_id,
    pid: process.pid,
    rawState: expectedRaw,
    jobCountDelta: 1,
    executionCountDelta: 1,
    process,
    logIds: [...client.logIds].filter((logId) => !previousLogs.has(logId)),
  });
  return { job, directory };
}

// 正常归档已安装；此处仅让运行输出无效，不能误当作安装错误。
export async function invalidRaw(context, item) {
  const { client, evidence, histories } = context;
  const label = `${item.platform}_bad_raw`;
  const before = await jobs(client);
  const beforeKeys = keys(await events(item));
  await control(item, { label, rawCase: 'utf8-101', state: 'unknown' });
  const transport = item.protocol === 2 ? 'http' : 'mcp';
  if (transport === 'http')
    await client.refresh(item.provider, { status: 502, code: 'dependency_failed' });
  else
    await client.tool(
      'deviceforge.refresh_devices',
      { id: item.id, generation: item.provider.generation },
      'dependency_failed',
    );
  const submitted = singleJob(before, await jobs(client), item.discoverOperation);
  await client.finished(submitted.id, 'failed');
  const process = await cleaned(item, label);
  const added = keys(await events(item)).filter((key) => !beforeKeys.includes(key));
  assert.deepEqual(added, [`${process.request_id}/${process.pid}`]);
  await noDirectory(client, item);
  histories.set(submitted.id, await history(client, submitted.id));
  evidence.entries.push({
    providerId: item.id,
    protocol: item.protocol,
    generation: item.provider.generation,
    entry: 'refresh-invalid-raw',
    transport,
    label,
    operation: item.discoverOperation,
    jobId: submitted.id,
    requestId: process.request_id,
    pid: process.pid,
    status: 'failed',
    jobCountDelta: 1,
    executionCountDelta: 1,
    process,
  });
}
