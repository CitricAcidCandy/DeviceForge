import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cleaned, control, events, exited } from '../unified-discovery/fixtures.mjs';
import { poll } from '../device-provider/client.mjs';
import { assertDirectory, assertLegacyArray, assertSingleJob } from './observations.mjs';
import { callEntry, entryOperation, jobList, history } from './requests.mjs';
import { executionKeys, expectedDevices, oneDiscovery } from './checks.mjs';
import { assertOwnerAbsent, install, providersFor, registrations } from './admission.mjs';
import { passed } from './evidence.mjs';

function directProcessEvidence(item, evidence) {
  if (item.protocol !== 1) return evidence;
  assert.equal(evidence.cancellation_received, false);
  return { ...evidence, cooperative_confirmation: false,
    cleanup_scope: '仅本次直接PID、响应写完、EOF与零退出；协议1无合作清理确认，不证明外部资源或进程树清理' };
}

async function protocolOneDiscovery(context, item, { entry, transport, label }) {
  const { client, report } = context;
  const snapshot = await control(item, { label, rawCase: 'valid', model: '协议1模拟设备' });
  const before = await jobList(client), beforeKeys = await executionKeys(context.fixtures.all);
  const returned = await callEntry(client, item.provider, { entry, transport, alias: item.alias });
  const id = entry === 'refresh' ? returned.discovery_job_id : returned.id;
  const job = await client.finished(id, 'succeeded');
  assertSingleJob(before, await jobList(client), entryOperation(item.provider, entry, item.alias), id);
  const directories = await poll(() => client.json('/api/v2/devices'),
    (all) => all.some((directory) => directory.provider.id === item.id && directory.discovery_job_id === id),
    `${label} 本次协议1目录接受`);
  assert.deepEqual(await client.tool('deviceforge.list_devices'), directories);
  const directory = directories.find((value) => value.provider.id === item.id);
  const expected = expectedDevices(item, snapshot);
  assertDirectory(directory, item.provider, expected, id);
  if (entry === 'refresh') assert.deepEqual(returned, directory);
  if (entry === 'alias') assertLegacyArray(job.result, expected, item.platform);
  else assert.deepEqual(job.result, expected.map((device) => ({ id: device.local_id,
    state: device.state, model: device.model, raw_state: device.raw_state,
    capabilities: device.capabilities.map(({ id, version, available }) => ({ id, version, available })) })),
    '协议1的Json来源必须保留裸发现数组，不能增加或猜测宿主包装');
  const process = directProcessEvidence(item, await cleaned(item, label, { atReturn: true }));
  const keys = await executionKeys(context.fixtures.all);
  assert.equal(keys.length, beforeKeys.length + 1);
  assert.ok(keys.includes(`${item.id}:${process.request_id}:${process.pid}`));
  const retained = await history(client, id);
  assert.deepEqual(retained.job, job);
  const evidence = { plugin_id: item.id, protocol_version: 1, devices_api_version: 3,
    executor_result_format: 'Json', public_result_format: entry === 'alias' ? 'legacy_array' : 'bare_array',
    entry, transport, label, job_id: id, historical_operation: job.operation, job_input: {},
    current_discovery_job_id: directory.discovery_job_id,
    raw_state_present: directory.devices.map((device) => Object.hasOwn(device, 'raw_state')),
    raw_state_utf8_bytes: directory.devices.map((device) => Buffer.byteLength(device.raw_state, 'utf8')),
    raw_state_sha256: directory.devices.map((device) => createHash('sha256').update(device.raw_state, 'utf8').digest('hex')),
    normalized_states: directory.devices.map((device) => device.state), process, event_count: retained.events.length };
  report.discoveries ??= [];
  report.discoveries.push(evidence);
  return evidence;
}

async function rejectedRefresh(context, item, options) {
  const { client } = context;
  const before = await jobList(client), beforeKeys = await executionKeys(context.fixtures.all);
  const previous = await client.json('/api/v2/devices');
  await control(item, options);
  await client.refresh(item.provider, { status: 502, code: 'dependency_failed' });
  const after = await jobList(client), oldIds = new Set(before.map((job) => job.id));
  const added = after.filter((job) => !oldIds.has(job.id));
  assert.equal(added.length, 1, '准入后的整份观测失败仍只有一个Job');
  assertSingleJob(before, after, item.discoverOperation, added[0].id);
  await client.finished(added[0].id, 'failed');
  const current = await client.json('/api/v2/devices');
  assert.deepEqual(await client.tool('deviceforge.list_devices'), current);
  assert.ok(!current.some((directory) => directory.provider.id === item.id), '坏观测整份失败，开始执行已清旧目录，不恢复旧raw');
  assert.deepEqual(current.filter((directory) => directory.provider.id !== item.id),
    previous.filter((directory) => directory.provider.id !== item.id), '坏观测不撤销其它提供者目录');
  const process = directProcessEvidence(item, await cleaned(item, options.label, { atReturn: true }));
  const afterKeys = await executionKeys(context.fixtures.all);
  assert.equal(afterKeys.length, beforeKeys.length + 1);
  if (item.protocol === 1) assert.ok(afterKeys.includes(`${item.id}:${process.request_id}:${process.pid}`));
  await history(client, added[0].id);
  return { label: options.label, job_id: added[0].id, status: 502, code: 'dependency_failed', process };
}

async function missingLegacy(context, item, rawCase) {
  const label = `${item.id}_legacy_${rawCase}`;
  const before = await jobList(context.client), beforeKeys = await executionKeys(context.fixtures.all);
  await control(item, { label, rawCase });
  const returned = await callEntry(context.client, item.provider, { entry: 'alias', transport: 'mcp', alias: item.alias });
  const job = await context.client.finished(returned.id, 'failed');
  assertSingleJob(before, await jobList(context.client), item.alias, job.id);
  assert.ok(!(await context.client.json('/api/v2/devices')).some((directory) => directory.provider.id === item.id),
    '专用旧数组缺少完整raw时整个Job失败且无目录');
  const process = await cleaned(item, label, { atReturn: true });
  assert.equal((await executionKeys(context.fixtures.all)).length, beforeKeys.length + 1);
  await history(context.client, job.id);
  return { raw_case: rawCase, job_id: job.id, job_status: job.status, process };
}

async function verifyProtocolOne(context) {
  const { client, report } = context, item = context.fixtures.protocolOne;
  assert.equal(item.protocol, 1); assert.equal(item.devicesApiVersion, 3);
  await install(client, item);
  await client.manage(item.id, 'load');
  await providersFor(client, [item]);
  report.protocol_one = { plugin_id: item.id, executor_result_format: 'Json',
    alias: item.alias, platform: item.platform,
    provider: { id: item.provider.id, generation: item.provider.generation,
      devices_api_version: item.provider.definition.api_version,
      capabilities: item.provider.definition.capabilities.map((capability) => ({ id: capability.id,
        execution_timeout_ms: capability.execution_timeout_ms ?? null,
        execution_timeout_omitted: capability.execution_timeout_ms === undefined })) } };
  const successes = [];
  successes.push(await protocolOneDiscovery(context, item, { entry: 'direct', transport: 'http',
    label: `${item.id}_bare_direct_http` }));
  successes.push(await protocolOneDiscovery(context, item, { entry: 'alias', transport: 'mcp',
    label: `${item.id}_legacy_alias_mcp` }));
  const rejected = { plugin_id: item.id, protocol_version: 1, devices_api_version: 3,
    executor_result_format: 'Json', supplied_result_format: 'business_result_artifacts_object',
    job_status: 'failed', directory_absent: true,
    ...await rejectedRefresh(context, item, { label: `${item.id}_reject_business_wrapper`, resultMode: 'pseudo-wrapper' }) };
  successes.push(await protocolOneDiscovery(context, item, { entry: 'refresh', transport: 'http',
    label: `${item.id}_recover_bare_refresh_http` }));
  // 独立协议1部署在本阶段撤销，避免改变后续冻结重启矩阵的owner集合。
  const unloaded = await client.manage(item.id, 'unload');
  assert.equal(unloaded.state, 'unloaded'); assert.equal(unloaded.cleanup_failed, false);
  assert.equal(unloaded.generation, item.provider.generation);
  const removed = await client.json(`/api/v2/plugin-packages/server/${item.id}`, { method: 'DELETE' });
  assert.equal(removed.id, item.id);
  assertOwnerAbsent(await registrations(client), item);
  assert.ok(!(await client.json('/api/v2/devices')).some((directory) => directory.provider.id === item.id));
  assert.ok(!(await client.json('/api/v2/plugin-packages/server')).some((packageItem) => packageItem.id === item.id));
  for (const recorded of [...successes, rejected]) await history(client, recorded.job_id);
  report.protocol_one.deployment_deleted_before_restart = true;
  report.protocol_one.http_mcp_owner_absent = true;
  passed(report, '协议1/API3 Json裸数组、同Job原文与独立旧数组；EOF不代表合作清理', { cases: successes });
  passed(report, '协议1业务伪result/artifacts整份502 dependency_failed，无目录且仅一Job一调用', { cases: [rejected] });
}

export async function verifyRaw(context) {
  const cases = [];
  for (const item of context.fixtures.items.filter((entry) => entry.devicesApiVersion < 3)) {
    for (const rawCase of ['missing', 'null']) {
      const result = await oneDiscovery(context, item, { label: `${item.id}_compat_${rawCase}`, rawCase,
        entry: 'direct', transport: 'mcp' });
      cases.push({ plugin_id: item.id, protocol_version: item.protocol, devices_api_version: item.devicesApiVersion,
        raw_case: rawCase, job_id: result.job.id, directory_raw_omitted: true });
    }
    for (const rawCase of ['valid', 'empty']) {
      const failure = await rejectedRefresh(context, item, { label: `${item.id}_reject_${rawCase}`, rawCase });
      cases.push({ plugin_id: item.id, raw_case: rawCase, ...failure });
      await oneDiscovery(context, item, { label: `${item.id}_recover_${rawCase}`, rawCase: 'missing' });
    }
  }
  passed(context.report, '设备API1/2缺失或null兼容，非null原文整份拒绝', { cases });

  const rawEvidence = [];
  for (const item of context.fixtures.items.filter((entry) => entry.devicesApiVersion === 3)) {
    for (const rawCase of ['valid', 'recovery', 'sideload', 'bootloader', 'unknown', 'ascii-100', 'utf8-100']) {
      const result = await oneDiscovery(context, item, { label: `${item.id}_raw_${rawCase}`,
        rawCase, entry: 'alias', transport: 'http' });
      rawEvidence.push({ plugin_id: item.id, protocol_version: item.protocol, devices_api_version: 3,
        raw_case: rawCase, job_id: result.job.id, utf8_bytes: result.evidence.raw_state_utf8_bytes[0],
        legacy_array_exact: true, directory_same_job: true });
    }
    for (const rawCase of ['missing', 'null']) {
      await oneDiscovery(context, item, { label: `${item.id}_api3_${rawCase}`, rawCase, entry: 'refresh', transport: 'mcp' });
      rawEvidence.push({ plugin_id: item.id, raw_case: rawCase, api3_refresh_allowed: true,
        legacy: await missingLegacy(context, item, rawCase) });
      await oneDiscovery(context, item, { label: `${item.id}_legacy_recover_${rawCase}` });
    }
    const empty = await oneDiscovery(context, item, { label: `${item.id}_empty`, mode: 'empty', entry: 'alias', transport: 'mcp' });
    assert.deepEqual(empty.job.result, []);
    for (const state of ['offline', 'unauthorized', 'unknown']) {
      const observed = await oneDiscovery(context, item, { label: `${item.id}_normalized_${state}`,
        state, rawCase: 'recovery', entry: 'alias', transport: 'mcp' });
      const before = await jobList(context.client), keys = await executionKeys(context.fixtures.all);
      const action = { provider_id: item.id, generation: item.provider.generation, device_id: item.localId,
        capability: 'device_read', version: 1, input: {} };
      await context.client.post('/api/v2/device-actions', action, { status: 409, code: 'conflict' });
      await context.client.tool('deviceforge.invoke_device', action, 'conflict');
      assert.deepEqual(await jobList(context.client), before, '特殊raw原文不能放行归一化不可用设备动作');
      assert.deepEqual(await executionKeys(context.fixtures.all), keys);
      rawEvidence.push({ plugin_id: item.id, job_id: observed.job.id, raw_case: 'recovery',
        normalized_state: state, action_status: 409, action_code: 'conflict', action_created_jobs: 0 });
    }
    await oneDiscovery(context, item, { label: `${item.id}_normalized_recover` });
    const failures = ['empty', 'whitespace', 'ascii-101', 'utf8-101', 'unicode-control', 'ascii-control', 'number', 'boolean', 'array', 'object'];
    for (const rawCase of failures) {
      const failure = await rejectedRefresh(context, item, { label: `${item.id}_badraw_${rawCase}`, rawCase });
      rawEvidence.push({ plugin_id: item.id, raw_case: rawCase, ...failure });
      await oneDiscovery(context, item, { label: `${item.id}_raw_recover_${rawCase}` });
    }
    for (const [name, options] of [
      ['mixed_bad_raw', { mode: 'mixed-bad-raw' }],
      ['pseudo_wrapper', { resultMode: 'pseudo-wrapper' }],
      ['pseudo_wrapper_extra', { resultMode: 'pseudo-wrapper-extra' }],
      ['object_result', { resultMode: 'object' }],
    ]) {
      rawEvidence.push({ plugin_id: item.id, case: name,
        ...await rejectedRefresh(context, item, { label: `${item.id}_${name}`, ...options }) });
      await oneDiscovery(context, item, { label: `${item.id}_recover_${name}` });
    }
  }
  passed(context.report, 'API3特殊/未知原文保真、UTF-8及控制符边界、有限旧数组与来源解码', { cases: rawEvidence });
  await verifyProtocolOne(context);
}

export async function verifyAllProcesses(items, report) {
  const processes = [];
  report.fixture_processes = processes;
  for (const item of items) {
    const observed = await events(item);
    for (const start of observed.filter((event) => event.kind === 'started')) {
      assert.equal(start.provider_id, item.id);
      assert.equal(start.protocol, item.protocol);
      assert.equal(start.devices_api_version, item.devicesApiVersion);
      const cancellation = report.cancellations?.find((entry) => entry.plugin_id === item.id
        && entry.request_id === start.request_id && entry.pid === start.pid);
      let evidence;
      if (cancellation?.protocol === 2) {
        assert.equal(exited(start.pid), true, '协议2取消后的同一直接PID必须确实退出');
        evidence = cancellation;
      } else evidence = directProcessEvidence(item, await cleaned(item, start.label, { atReturn: true }));
      const related = observed.filter((event) => event.pid === start.pid && event.request_id === start.request_id);
      processes.push({ plugin_id: item.id, ...evidence,
        timeline: related.map(({ kind, at, sequence, exit_code }) => ({ kind, at, sequence, ...(exit_code !== undefined ? { exit_code } : {}) })) });
    }
  }
  return processes;
}
