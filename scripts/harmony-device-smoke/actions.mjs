import assert from 'node:assert/strict';
import { names, alias, operation } from './deployment.mjs';
import { finishedTool, keys, localId, observations } from './fixtures.mjs';
import { jobList, oneJob, record, uuid } from './jobs.mjs';

export const action = (provider, capability, deviceId, input = {}) => ({
  provider_id: provider.id, generation: provider.generation, device_id: deviceId, capability, version: 1, input,
});
export const envelope = (deviceId, input = {}) => ({ device_id: deviceId, input });
export const legacyInput = (name) => ({
  discover: {}, packages: { device_id: localId }, 'app.uninstall': { device_id: localId, package: 'com.smoke.harmony' },
  'app.install': { device_id: localId, artifact_id: 'd0da1b1b-919c-40a8-9c71-fbb56614e488' },
}[name]);

export async function noFallback(host, fixture, report, phase) {
  const before = await jobList(host), previous = await keys(fixture);
  for (const name of names) {
    const input = legacyInput(name), direct = name === 'discover' ? {} : envelope(input.device_id,
      Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'device_id')));
    for (const [id, value] of [[alias(name), input], [operation(name), direct]]) {
      await host.client.post('/api/v2/jobs', { operation: id, input: value }, { status: 404, code: 'not_found' });
      await host.client.tool(id, value, 'not_found');
    }
  }
  assert.deepEqual(await jobList(host), before); assert.deepEqual(await keys(fixture), previous);
  report.checks.push({ name: phase + ' 四旧名/四新贡献404/not_found、零Job/零工具，无内置回退', passed: true });
}
export async function preciseErrors(host, fixture, report, { beforeDiscovery = false } = {}) {
  const base = action(report.provider, 'packages', localId), before = await jobList(host), previous = await keys(fixture);
  const cases = beforeDiscovery ? [['未观测', base, 409, 'conflict']] : [
    ['未知提供者', { ...base, provider_id: 'not_installed_provider' }, 404, 'not_found'],
    ['未知能力', { ...base, capability: 'undeclared' }, 404, 'not_found'],
    ['能力版本不符', { ...base, version: 2 }, 404, 'not_found'],
    ['未知设备', { ...base, device_id: 'not_observed_device' }, 404, 'not_found'],
    ['旧代引用', { ...base, generation: '00000000-0000-4000-8000-000000000000' }, 409, 'conflict'],
    ['设备范围缺失', { ...base, device_id: null }, 400, 'invalid_input'],
    ['输入非对象', { ...base, input: [] }, 400, 'invalid_input'],
    ['版本无效', { ...base, version: 0 }, 400, 'invalid_input'],
    ['未知封套字段', { ...base, unexpected: true }, 400, 'invalid_input'],
  ];
  for (const [name, request, status, code] of cases) {
    const observed = host.client.scope({ case_id: '准入-' + name, phase: 'reject' });
    await observed.post('/api/v2/device-actions', request, { status, code });
    await observed.tool('deviceforge.invoke_device', request, code);
  }
  assert.deepEqual(await jobList(host), before); assert.deepEqual(await keys(fixture), previous);
  report.checks.push({ name: '设备能力精确HTTP/MCP拒绝，零Job/零工具', passed: true, cases: cases.map(([name, , status, code]) => ({ name, status, code })) });
}
export async function submitAction(host, report, caseId, request, transport = 'http') {
  report.active_case_id = caseId; const observed = host.client.scope({ case_id: caseId, phase: 'submit' });
  const job = transport === 'http' ? await observed.post('/api/v2/device-actions', request, { status: 202 })
    : await observed.tool('deviceforge.invoke_device', request);
  assert.match(job.id, uuid);
  const entry = { case_id: caseId, operation: operation(request.capability), input: envelope(request.device_id, request.input), transport,
    job_id: job.id, submit_log_id: report.last_request.log_id, expected_status: 'succeeded' };
  assert.match(entry.submit_log_id, uuid); report.jobs.push(entry); return entry;
}
export async function ordinaryBusiness(host, fixture, report) {
  for (const name of ['packages', 'app.uninstall']) for (const transport of ['http', 'mcp']) {
    const input = name === 'packages' ? {} : { package: 'com.smoke.harmony' };
    const argv = name === 'packages' ? ['-t', localId, 'shell', 'bm', 'dump', '-a'] : ['-t', localId, 'uninstall', input.package];
    const result = { output: name === 'packages' ? 'com.alpha.app\ncom.beta.app' : 'msg:uninstall bundle successfully.' };
    const before = await jobList(host), previous = await keys(fixture);
    const entry = await submitAction(host, report, name + '-capability-' + transport, action(report.provider, name, localId, input), transport);
    const job = await record(host, entry);
    const ids = new Set(before.map((item) => item.id)); assert.deepEqual((await jobList(host)).filter((item) => !ids.has(item.id)).map((item) => item.id), [entry.job_id]);
    const added = (await observations(fixture)).filter((item) => !previous.includes(item.directory));
    assert.equal(added.length, 1); assert.deepEqual(added[0].ready.argv, argv); entry.tool = await finishedTool(added[0]);
    assert.deepEqual(job.result, { result, artifacts: [] }); assert.equal(job.error, null);
    await oneJob(host, fixture, report, { caseId: name + '-alias-' + transport, operation: alias(name), input: { device_id: localId, ...input }, transport, argv, expected: result });
  }
  report.checks.push({ name: '包列表/卸载能力及旧alias的HTTP/MCP业务、同Job双端历史、固定argv', passed: true });
}
