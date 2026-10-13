import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { assertDirectory } from '../unified-discovery-smoke/observations.mjs';
import { jobList, record, submit } from '../harmony-device-smoke/jobs.mjs';
import { alias, deviceCapabilities, localId, operation, otherId, pluginId, uuid } from './contracts.mjs';
import { advance, callCount, cases, configureHdc, finishTools, prepareDiscoveryTool, prepareInputTool,
  readyCall, release, setResponse } from './fixtures.mjs';

export const action = (provider, selected = cases[0].action, device = localId) => ({
  provider_id: provider.id, generation: provider.generation, device_id: device, capability: 'input', version: 1,
  input: { action: selected },
});

export async function submitInput(host, report, caseId, { point = 'capability', transport = 'http',
  selected = cases[0], device = localId } = {}) {
  if (point === 'alias') return submit(host, report, caseId, alias('input'), { device_id: device, action: selected.action }, transport);
  if (point === 'direct') return submit(host, report, caseId, operation('input'), { device_id: device, input: { action: selected.action } }, transport);
  assert.equal(point, 'capability'); report.active_case_id = caseId;
  const observed = host.client.scope({ case_id: caseId, phase: 'submit' });
  const request = action(report.provider, selected.action, device);
  const submitted = transport === 'http' ? await observed.post('/api/v2/device-actions', request, { status: 202 })
    : await observed.tool('deviceforge.invoke_device', request);
  assert.match(submitted.id, uuid); assert.match(report.last_request.log_id, uuid);
  const entry = { case_id: caseId, operation: operation('input'), input: { device_id: device, input: { action: selected.action } },
    transport, job_id: submitted.id, submit_log_id: report.last_request.log_id, expected_status: 'succeeded' };
  report.jobs.push(entry); return entry;
}

export async function assertTools(entry, fixture, calls, normal = true) {
  assert.equal(await callCount(fixture), calls); entry.tools = await finishTools(fixture);
  assert.equal(entry.tools.length, calls);
  const parents = new Set();
  for (const tool of entry.tools) {
    assert.equal(tool.process.exit.target.state, 'exited'); assert.equal(tool.process.exit.parent.state, 'exited');
    assert.equal(tool.process.exit.parent.exit_code, 0); parents.add(tool.process.ready.parent.pid);
    if (normal) assert.equal(tool.process.exit.target.exit_code, 0);
  }
  assert.equal(parents.size, 1); assert.deepEqual(await readdir(fixture.scratchRoot), []);
}

export async function discover(host, deployment, report, options, phase = 'first', eligible = true) {
  const ids = eligible ? [localId, otherId] : [localId];
  const fixture = await prepareDiscoveryTool(options, report, phase + '-discovery', ids);
  if (!eligible) await setResponse(fixture, 2, 'stdout', '5.0.1.2\nDF_INPUT_DONE:{{TOKEN}}:version:0\n');
  await configureHdc(deployment, fixture, report);
  const entry = await submit(host, report, phase + '-发现', operation('discover'), {});
  const calls = eligible ? 5 : 2;
  await advance(fixture, calls, { probeBinary: options.probeBinary }); await record(host, entry);
  const capabilities = deviceCapabilities.map((id) => ({ id, version: 1, available: id !== 'input' || eligible,
    ...(!eligible && id === 'input' ? { reason: '设备uitest未通过当前固定输入档案资格探测' } : {}) }));
  const raw = ids.map((id) => ({ id, state: 'online', raw_state: 'device', capabilities }));
  assert.deepEqual(entry.history.result, { result: raw, artifacts: [] }); assert.equal(entry.history.error, null);
  const directories = await poll(() => host.client.json('/api/v2/devices'),
    (value) => value.some((item) => item.provider.id === pluginId && item.discovery_job_id === entry.job_id), '本次输入资格目录');
  assert.deepEqual(await host.client.tool('deviceforge.list_devices'), directories);
  const directory = directories.find((item) => item.provider.id === pluginId);
  const expected = ids.map((local_id) => ({ local_id, state: 'online', raw_state: 'device',
    capabilities: capabilities.map((entry) => ({ ...entry, reason: entry.reason ?? null })) }));
  assertDirectory(directory, report.provider, expected, entry.job_id);
  await assertTools(entry, fixture, calls); entry.directory = directory;
  report.checks.push({ name: phase + ' 九availability、独立版本/帮助资格和HTTP/MCP目录原文', passed: true,
    input_available: eligible, job_id: entry.job_id });
}

export async function normalCase(host, deployment, report, options, { caseId, selected = cases[0],
  point = 'capability', transport = 'http', device = localId } = {}) {
  const fixture = await prepareInputTool(options, report, caseId, selected, device);
  await configureHdc(deployment, fixture, report);
  const before = new Set((await jobList(host)).map((entry) => entry.id));
  const entry = await submitInput(host, report, caseId, { selected, point, transport, device });
  await advance(fixture, fixture.plans.length, { probeBinary: options.probeBinary });
  await record(host, entry); assert.equal(entry.history.error, null);
  assert.deepEqual((await jobList(host)).filter((entry) => !before.has(entry.id)).map((entry) => entry.id), [entry.job_id]);
  const result = { device_id: device, action: selected.kind, dispatched: true };
  assert.deepEqual(entry.history.result, point === 'alias' ? result : { result, artifacts: [] });
  await assertTools(entry, fixture, selected.enter ? 4 : 3);
  assert.equal(entry.tools[0].token, entry.tools[1].token); assert.notEqual(entry.tools[1].token, entry.tools[2].token);
  if (selected.enter) assert.equal(entry.tools[2].token, entry.tools[3].token);
  report.checks.push({ name: caseId + ' 唯一Job、固定平台argv、空产物、原文本字面量与真实父子退出', passed: true, job_id: entry.job_id });
  return entry;
}

export async function normalEntries(host, deployment, report, options) {
  for (const selected of cases) for (const transport of ['http', 'mcp']) for (const point of ['capability', 'direct', 'alias']) {
    await normalCase(host, deployment, report, options, { caseId: 'normal-' + selected.kind + '-' + transport + '-' + point, selected, transport, point });
  }
}

export async function inputErrors(host, deployment, report, options) {
  const fixture = await prepareInputTool(options, report, 'strict-input'); await configureHdc(deployment, fixture, report);
  const before = await jobList(host);
  for (const selected of [{}, { kind: 'tap', x: 0, y: 2 }, { kind: 'tap', x: 1, y: 2, extra: true },
    { kind: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, duration_ms: 10 },
    { kind: 'keyevent', key_code: 2054, long_press: false },
    { kind: 'text', text: 'value' }, { kind: 'text', x: 1, y: 2, text: 'value', enter: null }]) {
    const observed = host.client.scope({ case_id: 'strict-input', phase: 'reject' });
    await observed.post('/api/v2/device-actions', action(report.provider, selected), { status: 400, code: 'invalid_input' });
    await observed.tool('deviceforge.invoke_device', action(report.provider, selected), 'invalid_input');
    for (const [name, input] of [[operation('input'), { device_id: localId, input: { action: selected } }],
      [alias('input'), { device_id: localId, action: selected }]]) {
      await observed.post('/api/v2/jobs', { operation: name, input }, { status: 400, code: 'invalid_input' });
      await observed.tool(name, input, 'invalid_input');
    }
  }
  for (const envelope of [{ device_id: localId, input: { action: cases[0].action }, extra: true },
    { device_id: localId, input: { action: cases[0].action, extra: true } }]) {
    await host.client.post('/api/v2/jobs', { operation: operation('input'), input: envelope }, { status: 400, code: 'invalid_input' });
    await host.client.tool(operation('input'), envelope, 'invalid_input');
  }
  assert.deepEqual(await jobList(host), before); assert.equal(await callCount(fixture), 0);
  for (const [selected, message] of [
    [{ kind: 'swipe', x1: 1, y1: 2, x2: 1, y2: 2 }, 'Harmony滑动须有位移，速度须为200至40000像素每秒'],
    [{ kind: 'keyevent', key_code: 66 }, 'Harmony按键码不在固定官方档案的可用表中'],
    [{ kind: 'text', x: 1, y: 2, text: '界'.repeat(342) }, 'Harmony文本须为1至1024个UTF-8字节且不含控制符'],
  ]) {
    const entry = await submitInput(host, report, 'semantic-' + selected.kind, { selected: { action: selected }, point: 'direct' });
    await record(host, entry, 'failed'); assert.equal(entry.history.result, null);
    assert.equal(entry.history.error, '依赖执行失败：输入无效：' + message); entry.tools = [];
    assert.equal(await callCount(fixture), 0);
  }
  report.checks.push({ name: 'HTTP/MCP三入口模式拒绝零Job，语义拒绝保留失败Job；所有非法输入零工具', passed: true });
}

export async function qualification(host, deployment, report, options) {
  for (const ordinal of [1, 2]) {
    const fixture = await prepareInputTool(options, report, 'requalify-' + ordinal);
    const output = ordinal === 1 ? '5.0.1.2\nDF_INPUT_DONE:{{TOKEN}}:version:0\n' : 'invalid help\nDF_INPUT_DONE:{{TOKEN}}:help:0\n';
    await setResponse(fixture, ordinal, 'stdout', output); await configureHdc(deployment, fixture, report);
    const entry = await submitInput(host, report, 'requalify-' + ordinal, { transport: ordinal === 1 ? 'http' : 'mcp' });
    await advance(fixture, ordinal, { probeBinary: options.probeBinary }); await record(host, entry, 'failed');
    const message = ordinal === 1 ? '设备uitest版本不在当前固定输入档案中' : '设备uitest帮助不符合当前固定输入档案';
    assert.equal(entry.history.error, '依赖执行失败：工具依赖失败：' + message); assert.equal(entry.history.result, null);
    await assertTools(entry, fixture, ordinal); assert.ok(!entry.tools.some((tool) => tool.stage === 'action'));
  }
  await discover(host, deployment, report, options, 'ineligible', false);
  await discover(host, deployment, report, options, 'eligible-again', true);
  report.checks.push({ name: '在线资格不乐观授予、每次执行重新核对版本/帮助且不发送动作', passed: true });
}

export async function noRelease(fixture, ordinal) {
  await assert.rejects(lstat(join(fixture.toolRoot, 'plan-' + String(ordinal).padStart(2, '0'), 'release')), { code: 'ENOENT' });
}
