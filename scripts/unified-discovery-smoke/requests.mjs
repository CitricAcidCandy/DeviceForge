import assert from 'node:assert/strict';

export const entries = ['refresh', 'direct', 'alias'];
export const transports = ['http', 'mcp'];

export function entryOperation(provider, entry, alias) {
  assert.ok(entries.includes(entry));
  if (entry === 'alias') {
    assert.ok(typeof alias === 'string' && alias.length > 0);
    return alias;
  }
  return provider.definition.discover_operation;
}

// refresh身份属于传输层，其余两入口才有业务input；全部成功发现只发送{}。
export async function callEntry(client, provider, { entry, transport, alias, input = {}, status, code }) {
  assert.ok(entries.includes(entry) && transports.includes(transport));
  if (entry === 'refresh') {
    assert.deepEqual(input, {}, '成功refresh不把管理员控制参数塞进业务输入');
    if (transport === 'http') return client.refresh(provider, { status: status ?? 200, code });
    return client.tool('deviceforge.refresh_devices', { id: provider.id, generation: provider.generation }, code);
  }
  const operation = entryOperation(provider, entry, alias);
  if (transport === 'http') return client.post('/api/v2/jobs', { operation, input }, { status: status ?? 202, code });
  return client.tool(operation, input, code);
}

export async function rejectInput(client, provider, { entry, transport, alias, input }) {
  assert.ok(entries.includes(entry) && transports.includes(transport));
  if (entry === 'refresh') {
    // 额外字段放在刷新身份对象外层，验证薄边界拒绝，不伪造内部业务参数通道。
    const objectInput = input !== null && typeof input === 'object' && !Array.isArray(input);
    const body = objectInput ? { generation: provider.generation,
      ...(Object.hasOwn(input, 'generation') ? { input } : input) } : input;
    if (transport === 'http') return client.post(`/api/v2/device-providers/${provider.id}/refresh`, body,
      { status: 400, code: 'invalid_input' });
    const arguments_ = body !== null && typeof body === 'object' && !Array.isArray(body)
      ? { ...body, id: provider.id } : body;
    return client.tool('deviceforge.refresh_devices', arguments_, 'invalid_input');
  }
  return callEntry(client, provider, { entry, transport, alias, input, status: 400, code: 'invalid_input' });
}

export async function jobList(client) {
  const jobs = await client.json('/api/v2/jobs?limit=200');
  assert.ok(jobs.length < 200, '本次验收Job必须全部可枚举，不能以截断列表证明零Job');
  return jobs;
}

export async function publicSnapshot(client, executionKeys) {
  const jobs = await jobList(client);
  const directories = await client.json('/api/v2/devices');
  assert.deepEqual(await client.tool('deviceforge.list_devices'), directories);
  return { jobs, directories, executionKeys: [...executionKeys].sort() };
}

export async function history(client, id) {
  const job = await client.job(id);
  assert.deepEqual(await client.tool('deviceforge.get_job', { id }), job);
  const events = await client.json(`/api/v2/jobs/${id}/events`);
  assert.deepEqual(await client.tool('deviceforge.job_events', { id }), events);
  assert.ok(events.length > 0 && events.length < 200, '完整事件必须可枚举');
  return { job, events };
}

export const badInputs = [
  { name: '额外业务字段', input: { extra: true } },
  { name: '伪设备参数', input: { device_id: 'forged-device' } },
  { name: '伪代际参数', input: { generation: 'forged-generation' } },
  { name: '伪产物参数', input: { artifact_id: 'forged-artifact' } },
  { name: 'null', input: null }, { name: '数组', input: [] },
  { name: '字符串', input: 'not-an-object' },
];
