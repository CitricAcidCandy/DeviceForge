import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { poll } from '../device-provider/client.mjs';
import { cleaned, control, events } from '../unified-discovery/fixtures.mjs';
import {
  assertDirectory,
  assertLegacyArray,
  assertNoSideEffects,
  assertSingleJob,
} from './observations.mjs';
import {
  badInputs,
  callEntry,
  entries,
  entryOperation,
  history,
  jobList,
  publicSnapshot,
  rejectInput,
  transports,
} from './requests.mjs';
import { passed } from './evidence.mjs';

export function expectedDevices(item, snapshot) {
  if (snapshot.mode === 'empty') return [];
  const value = {
    local_id: item.localId,
    state: snapshot.state,
    model: snapshot.model ?? null,
    capabilities: [
      { id: 'device_read', version: 1, available: true, reason: null },
      { id: 'device_write', version: 1, available: true, reason: null },
    ],
  };
  if (Object.hasOwn(snapshot, 'rawState')) value.raw_state = snapshot.rawState;
  return [value];
}

function expectedRawResult(item, snapshot) {
  if (snapshot.mode === 'empty') return [];
  const device = {
    id: item.localId,
    state: snapshot.state,
    capabilities: [
      { id: 'device_read', version: 1, available: true },
      { id: 'device_write', version: 1, available: true },
    ],
  };
  if (snapshot.rawState !== undefined && snapshot.rawState !== null)
    device.raw_state = snapshot.rawState;
  if (snapshot.model !== undefined && snapshot.model !== null) device.model = snapshot.model;
  return [device];
}

export async function executionKeys(items) {
  const keys = [];
  for (const item of items)
    for (const event of await events(item)) {
      if (event.kind === 'started') keys.push(`${item.id}:${event.request_id}:${event.pid}`);
    }
  return keys.sort();
}

export async function oneDiscovery(
  context,
  item,
  { entry = 'refresh', transport = 'http', label, ...options },
) {
  const { client, report } = context;
  const snapshot = await control(item, { ...options, label });
  const beforeJobs = await jobList(client),
    beforeKeys = await executionKeys(context.fixtures.all);
  const returned = await callEntry(client, item.provider, { entry, transport, alias: item.alias });
  const jobId = entry === 'refresh' ? returned.discovery_job_id : returned.id;
  const job = await client.finished(jobId);
  const added = assertSingleJob(
    beforeJobs,
    await jobList(client),
    entryOperation(item.provider, entry, item.alias),
    jobId,
  );
  assert.equal(added.status, 'succeeded');
  // direct/alias历史Succeeded和目录接受不是跨资源事务；只等本次精确Job，不取另一轮目录替代。
  const directories = await poll(
    () => client.json('/api/v2/devices'),
    (all) =>
      all.some(
        (directory) => directory.provider.id === item.id && directory.discovery_job_id === jobId,
      ),
    `${label} 本次Job目录接受`,
  );
  assert.deepEqual(await client.tool('deviceforge.list_devices'), directories);
  const current = directories.find((directory) => directory.provider.id === item.id);
  assertDirectory(current, item.provider, expectedDevices(item, snapshot), jobId);
  if (entry === 'refresh')
    assert.deepEqual(returned, current, '串行测试中GET目录和本次回执应相同，不推断并发回执原子性');
  if (entry === 'alias' && item.legacy)
    assertLegacyArray(job.result, expectedDevices(item, snapshot), item.platform);
  else
    assert.deepEqual(
      job.result,
      { result: expectedRawResult(item, snapshot), artifacts: [] },
      'direct/identity保留协议2/3真实宿主包装，不能通过业务JSON外形猜来源',
    );
  const process = await cleaned(item, label, { atReturn: true });
  const afterKeys = await executionKeys(context.fixtures.all);
  assert.equal(afterKeys.length, beforeKeys.length + 1, '一次发现只执行一个真实目标');
  assert.ok(afterKeys.includes(`${item.id}:${process.request_id}:${process.pid}`));
  const recorded = await history(client, jobId);
  report.discoveries ??= [];
  const evidence = {
    plugin_id: item.id,
    protocol_version: item.protocol,
    devices_api_version: item.devicesApiVersion,
    entry,
    transport,
    label,
    job_id: jobId,
    historical_operation: job.operation,
    job_input: {},
    current_discovery_job_id: current.discovery_job_id,
    raw_state_present: current.devices.map((device) => Object.hasOwn(device, 'raw_state')),
    raw_state_utf8_bytes: current.devices.map((device) =>
      device.raw_state === undefined ? null : Buffer.byteLength(device.raw_state),
    ),
    raw_state_sha256: current.devices.map((device) =>
      device.raw_state === undefined
        ? null
        : createHash('sha256').update(device.raw_state, 'utf8').digest('hex'),
    ),
    normalized_states: current.devices.map((device) => device.state),
    process,
    event_count: recorded.events.length,
  };
  report.discoveries.push(evidence);
  return { job, directory: current, process, snapshot, evidence };
}

export async function verifyEntries(context) {
  for (const entry of entries)
    for (const transport of transports) {
      const evidence = [];
      for (const item of [...context.fixtures.items, context.fixtures.wide]) {
        const result = await oneDiscovery(context, item, {
          entry,
          transport,
          label: `${item.id}_${entry}_${transport}`,
          model: '模拟设备型号',
          rawCase: item.devicesApiVersion === 3 ? 'valid' : 'missing',
        });
        evidence.push({
          plugin_id: item.id,
          job_id: result.job.id,
          request_id: result.process.request_id,
        });
      }
      passed(context.report, `三入口一Job一真实执行：${entry}/${transport}`, { evidence });
    }
}

export async function verifyInvalidInputs(context) {
  const item = context.fixtures.wide,
    cases = [];
  for (const entry of entries)
    for (const transport of transports)
      for (const test of badInputs) {
        // MCP arguments只允许JsonObject；null/省略按SDK为{}，非对象属于协议解码边界。
        if (
          transport === 'mcp' &&
          (test.input === null || Array.isArray(test.input) || typeof test.input !== 'object')
        )
          continue;
        const before = await publicSnapshot(
          context.client,
          await executionKeys(context.fixtures.all),
        );
        await rejectInput(context.client, item.provider, {
          entry,
          transport,
          alias: item.alias,
          input: test.input,
        });
        const after = await publicSnapshot(
          context.client,
          await executionKeys(context.fixtures.all),
        );
        assertNoSideEffects(before, after);
        cases.push({
          entry,
          transport,
          case: test.name,
          code: 'invalid_input',
          ...(transport === 'http' ? { status: 400 } : {}),
          jobs_unchanged: true,
          directory_unchanged: true,
          executions_unchanged: true,
        });
      }
  passed(context.report, '较宽schema下三入口坏业务输入精确拒绝、零Job且旧目录保持', {
    cases,
    coverage: {
      http: '坏object及null/数组/字符串均走领域invalid_input',
      mcp: '只对坏JsonObject断言领域invalid_input',
      mcp_protocol:
        '标准arguments null/省略视为{}；数组/字符串协议解码拒绝本smoke未实测，不猜错误码',
    },
  });
}
