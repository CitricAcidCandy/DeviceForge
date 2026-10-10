import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { alias, names, operation, pluginId } from './deployment.mjs';
import { finishedTool, keys, localId, observations, offlineId, otherId, release, setMode, started } from './fixtures.mjs';
import { jobList, oneJob, record, submit, uuid } from './jobs.mjs';

export const action = (provider, capability, deviceId, input = {}) => ({
  provider_id: provider.id, generation: provider.generation, device_id: deviceId, capability, version: 1, input,
});
export const envelope = (deviceId, input = {}) => ({ device_id: deviceId, input });
export const legacyInput = (name) => ({
  discover: {}, connect: { address: '127.0.0.1:5555' }, disconnect: { address: '127.0.0.1:5555' },
  packages: { device_id: localId }, 'app.start': { device_id: localId, package: 'org.smoke.app' },
  'app.stop': { device_id: localId, package: 'org.smoke.app' },
  'app.uninstall': { device_id: localId, package: 'org.smoke.app' },
  input: { device_id: localId, action: { kind: 'tap', x: 11, y: 22 } },
  'app.install': { device_id: localId, artifact_id: 'd0da1b1b-919c-40a8-9c71-fbb56614e488' },
  'app.install_apks': { device_id: otherId, artifact_id: 'd0da1b1b-919c-40a8-9c71-fbb56614e488' },
  screenshot: { device_id: localId },
}[name]);

export async function noFallback(host, fixture, report, phase) {
  const before = await jobList(host), previous = fixture ? await keys(fixture) : [];
  for (const name of names) {
    const input = legacyInput(name);
    await host.client.post('/api/v2/jobs', { operation: alias(name), input }, { status: 404, code: 'not_found' });
    await host.client.tool(alias(name), input, 'not_found');
    await host.client.post('/api/v2/jobs', { operation: operation(name),
      input: name === 'discover' ? {} : envelope(input.device_id ?? null, Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'device_id'))) },
    { status: 404, code: 'not_found' });
    await host.client.tool(operation(name), name === 'discover' ? {} : envelope(input.device_id ?? null,
      Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'device_id'))), 'not_found');
  }
  assert.deepEqual(await jobList(host), before);
  if (fixture) assert.deepEqual(await keys(fixture), previous);
  report.checks.push({ name: phase + ' 十一旧名及新贡献404/not_found，零Job/零工具，无内置回退', passed: true });
}

export async function preciseErrors(host, fixture, report, { beforeDiscovery = false } = {}) {
  const base = action(report.provider, 'packages', localId), before = await jobList(host), previous = await keys(fixture);
  const cases = beforeDiscovery
    ? [['未观测', base, 409, 'conflict']]
    : [
      ['未知提供者', { ...base, provider_id: 'not_installed_provider' }, 404, 'not_found'],
      ['未知能力', { ...base, capability: 'undeclared' }, 404, 'not_found'],
      ['精确能力版本', { ...base, version: 2 }, 404, 'not_found'],
      ['未知设备', { ...base, device_id: 'not_observed_device' }, 404, 'not_found'],
      ['离线设备', { ...base, device_id: offlineId }, 409, 'conflict'],
      ['旧代引用', { ...base, generation: '00000000-0000-4000-8000-000000000000' }, 409, 'conflict'],
      ['范围错误', { ...base, device_id: null }, 400, 'invalid_input'],
      ['非对象能力输入', { ...base, input: [] }, 400, 'invalid_input'],
      ['非法版本', { ...base, version: 0 }, 400, 'invalid_input'],
      ['未知封套字段', { ...base, unexpected: true }, 400, 'invalid_input'],
    ];
  for (const [name, request, status, code] of cases) {
    const observed = host.client.scope({ case_id: '准入-' + name, phase: 'reject' });
    await observed.post('/api/v2/device-actions', request, { status, code });
    await observed.tool('deviceforge.invoke_device', request, code);
  }
  assert.deepEqual(await jobList(host), before); assert.deepEqual(await keys(fixture), previous);
  report.checks.push({ name: '设备能力精确HTTP状态/MCP领域码拒绝、零Job与零工具', passed: true,
    cases: cases.map(([name, , status, code]) => ({ name, status, code })) });
}

export async function sevenCapabilities(host, fixture, report) {
  const cases = [
    ['connect', 'http', { address: '127.0.0.1:5555' }, null, ['connect', '127.0.0.1:5555'], { output: 'connected to 127.0.0.1:5555' }],
    ['disconnect', 'mcp', { address: '127.0.0.1:5555' }, null, ['disconnect', '127.0.0.1:5555'], { output: 'disconnected 127.0.0.1:5555' }],
    ['packages', 'http', {}, localId, ['-s', localId, 'shell', 'pm', 'list', 'packages'], { output: 'package:com.failed.example\npackage:org.smoke.app' }],
    ['app.start', 'mcp', { package: 'org.smoke.app' }, localId, ['-s', localId, 'shell', 'monkey', '-p', 'org.smoke.app', '-c', 'android.intent.category.LAUNCHER', '1'], { output: 'Events injected: 1' }],
    ['app.stop', 'http', { package: 'org.smoke.app' }, localId, ['-s', localId, 'shell', 'am', 'force-stop', 'org.smoke.app'], { output: '' }],
    ['app.uninstall', 'mcp', { package: 'org.smoke.app' }, localId, ['-s', localId, 'uninstall', 'org.smoke.app'], { output: 'Success' }],
    ['input', 'http', { action: { kind: 'tap', x: 11, y: 22 } }, localId, ['-s', localId, 'shell', '-T', 'input', 'tap', '11', '22'], { device_id: localId, action: 'tap', dispatched: true }],
  ];
  for (const [name, transport, input, deviceId, argv, result] of cases) {
    await oneJob(host, fixture, report, { caseId: '七能力-' + name, operation: operation(name),
      input: envelope(deviceId, input), transport, argv, expected: { result, artifacts: [] } });
  }
  await oneJob(host, fixture, report, { caseId: '旧alias-packages', operation: alias('packages'),
    input: legacyInput('packages'), transport: 'mcp', argv: ['-s', localId, 'shell', 'pm', 'list', 'packages'],
    expected: { output: 'package:com.failed.example\npackage:org.smoke.app' } });
  report.checks.push({ name: '七能力各一Job/一工具、固定argv和完整结果；旧alias同Job投影', passed: true });
}

export async function submitAction(host, report, caseId, request, transport = 'http') {
  report.active_case_id = caseId;
  const observed = host.client.scope({ case_id: caseId, phase: 'submit' });
  const job = transport === 'http'
    ? await observed.post('/api/v2/device-actions', request, { status: 202 })
    : await observed.tool('deviceforge.invoke_device', request);
  assert.match(job.id, uuid);
  const entry = { case_id: caseId, operation: operation(request.capability),
    input: envelope(request.device_id, request.input), transport, job_id: job.id,
    submit_log_id: report.last_request.log_id, expected_status: 'succeeded' };
  assert.match(entry.submit_log_id, uuid); report.jobs.push(entry); return entry;
}

function ordered(first, second) {
  assert.ok(BigInt(first.completed.unix_ns) <= BigInt(second.ready.unix_ns), '锁等待者真实工具启动须晚于前工具完成响应');
}

export async function sharedLocks(host, fixture, report) {
  let before = await keys(fixture);
  await setMode(fixture, 'hold');
  const first = await submitAction(host, report, '同设备-first', action(report.provider, 'app.start', localId, { package: 'org.smoke.first' }));
  const held = await started(fixture, before, ['-s', localId, 'shell', 'monkey', '-p', 'org.smoke.first', '-c', 'android.intent.category.LAUNCHER', '1']);
  await setMode(fixture, 'normal');
  const queued = await submit(host, report, '同设备-alias', alias('app.stop'), { device_id: localId, package: 'org.smoke.queued' }, 'mcp');
  const parallel = await oneJob(host, fixture, report, { caseId: '不同设备-direct', operation: operation('app.stop'),
    input: envelope(otherId, { package: 'org.smoke.parallel' }), transport: 'http',
    argv: ['-s', otherId, 'shell', 'am', 'force-stop', 'org.smoke.parallel'], expected: { result: { output: '' }, artifacts: [] } });
  assert.equal((await observations(fixture)).some((item) => item.ready.argv.includes('org.smoke.queued')), false);
  before = await keys(fixture); await release(held); await record(host, first); await record(host, queued);
  first.tool = await finishedTool(held);
  const queuedTool = await started(fixture, before, ['-s', localId, 'shell', 'am', 'force-stop', 'org.smoke.queued']);
  queued.tool = await finishedTool(queuedTool); ordered(first.tool, queued.tool);
  assert.ok(BigInt(parallel.tool.ready.unix_ns) < BigInt(first.tool.completed.unix_ns));

  before = await keys(fixture); await setMode(fixture, 'hold');
  const barrier = await submitAction(host, report, '提供者-write', action(report.provider, 'disconnect', null, { address: '127.0.0.1:5555' }), 'mcp');
  const blocking = await started(fixture, before, ['disconnect', '127.0.0.1:5555']);
  await setMode(fixture, 'normal');
  const waitingRead = await submit(host, report, '提供者阻塞-read', alias('packages'), legacyInput('packages'), 'http');
  const waitingWrite = await submit(host, report, '提供者阻塞-direct-write', operation('app.stop'), envelope(otherId, { package: 'org.smoke.barrier' }), 'mcp');
  await delay(100);
  assert.deepEqual(await keys(fixture), [...before, blocking.directory].sort());
  await release(blocking); await record(host, barrier); await record(host, waitingRead); await record(host, waitingWrite);
  barrier.tool = await finishedTool(blocking);
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory) && item.directory !== blocking.directory);
  assert.equal(added.length, 2);
  for (const [entry, argv] of [
    [waitingRead, ['-s', localId, 'shell', 'pm', 'list', 'packages']],
    [waitingWrite, ['-s', otherId, 'shell', 'am', 'force-stop', 'org.smoke.barrier']],
  ]) {
    const item = added.find((candidate) => JSON.stringify(candidate.ready.argv) === JSON.stringify(argv));
    assert.ok(item); entry.tool = await finishedTool(item); ordered(barrier.tool, entry.tool);
  }
  report.checks.push({ name: '设备动作/直接jobs/旧alias共享同设备写锁、不同设备并行、提供者写屏障同时阻塞读写', passed: true,
    jobs: [first, queued, parallel, barrier, waitingRead, waitingWrite].map((entry) => entry.job_id),
    boundary: '真实工具时间与门闩证明旧动作顺序；APK/截图和APKS锁由各自组另验，不证明性能或外部ADB daemon' });
}
