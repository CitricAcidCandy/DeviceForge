import assert from 'node:assert/strict';
import { cleaned, control, events, exited, started } from '../unified-discovery/fixtures.mjs';
import { poll } from '../device-provider/client.mjs';
import { assertOwnerAbsent, providersFor, registrations } from './admission.mjs';
import { executionKeys, oneDiscovery } from './checks.mjs';
import { callEntry, history, jobList } from './requests.mjs';
import { passed } from './evidence.mjs';

async function assertNoDirectory(client, id) {
  const directories = await client.json('/api/v2/devices');
  assert.deepEqual(await client.tool('deviceforge.list_devices'), directories);
  assert.ok(!directories.some((directory) => directory.provider.id === id));
}

export async function verifyLifecycle(context) {
  const { client, fixtures, report } = context;
  report.cancellations = [];
  for (const protocol of [2, 3]) {
    const item = fixtures.items.find((entry) => entry.protocol === protocol && entry.devicesApiVersion === 3);
    const label = `${item.id}_running_cancel`;
    await control(item, { label, mode: 'hold' });
    const before = await jobList(client);
    const job = await callEntry(client, item.provider, { entry: 'direct', transport: protocol === 2 ? 'http' : 'mcp' });
    const start = await started(item, label);
    assert.equal((await jobList(client)).length, before.length + 1);
    if (protocol === 2) await client.post(`/api/v2/jobs/${job.id}/cancel`);
    else await client.tool('deviceforge.cancel_job', { id: job.id });
    await client.finished(job.id, 'cancelled');
    let evidence;
    if (protocol === 3) evidence = await cleaned(item, label, { cancelled: true });
    else {
      await poll(async () => exited(start.pid), Boolean, `${label} 已记录直接PID退出`);
      const observed = await events(item);
      evidence = { label, pid: start.pid, request_id: start.request_id, protocol: 2,
        process_exited: true, cleaned: observed.some((event) => event.request_id === start.request_id && event.kind === 'cleaned'),
        cleanup_scope: '仅同一个已记录直接PID不可见；不证明外部资源或进程树清理',
        exit_code: null, exit_code_observed: false, cooperative_confirmation: false };
    }
    await assertNoDirectory(client, item.id);
    const retained = await history(client, job.id);
    assert.equal(retained.job.operation, item.discoverOperation);
    assert.deepEqual(retained.job.input, {});
    report.cancellations.push({ plugin_id: item.id, job_id: job.id, job_status: 'cancelled', ...evidence });
    await oneDiscovery(context, item, { label: `${item.id}_cancel_recovery` });
  }
  passed(report, '运行取消先赢、无目录发布、历史HTTP/MCP一致；两协议清理证据分层', { cases: report.cancellations });

  const refreshItem = fixtures.items.find((entry) => entry.protocol === 3 && entry.devicesApiVersion === 3);
  const refreshCases = [];
  for (const transport of ['http', 'mcp']) {
    const label = `${refreshItem.id}_refresh_cancel_${transport}`;
    await control(refreshItem, { label, mode: 'hold' });
    const before = await jobList(client), ids = new Set(before.map((job) => job.id));
    // 挂起的本次refresh与cancel共享真实Job，捕获Promise防止拒绝成为未处理异常。
    const pending = callEntry(client, refreshItem.provider, { entry: 'refresh', transport,
      status: 409, code: 'cancelled' }).then((value) => ({ value }), (error) => ({ error }));
    const start = await started(refreshItem, label);
    const newJobs = (await jobList(client)).filter((job) => !ids.has(job.id));
    assert.equal(newJobs.length, 1);
    const job = newJobs[0];
    await client.tool('deviceforge.cancel_job', { id: job.id });
    const returned = await pending;
    if (returned.error) throw returned.error;
    assert.equal(returned.value.code, 'cancelled');
    await client.finished(job.id, 'cancelled');
    const process = await cleaned(refreshItem, label, { cancelled: true, atReturn: true });
    assert.equal(process.request_id, start.request_id);
    await assertNoDirectory(client, refreshItem.id);
    await history(client, job.id);
    const evidence = { plugin_id: refreshItem.id, job_id: job.id, job_status: 'cancelled', transport,
      ...(transport === 'http' ? { status: 409 } : {}), code: 'cancelled', ...process };
    report.cancellations.push(evidence); refreshCases.push(evidence);
    await oneDiscovery(context, refreshItem, { label: `${refreshItem.id}_refresh_cancel_recover_${transport}` });
  }
  passed(report, '在途HTTP/MCP refresh精确cancelled回执，一Job且合作退出后返回', { cases: refreshCases });

  const item = fixtures.items.find((entry) => entry.protocol === 3 && entry.devicesApiVersion === 3);
  const accepted = await oneDiscovery(context, item, { label: `${item.id}_accepted_before_cancel`, entry: 'alias', transport: 'mcp' });
  const acceptedHistory = await history(client, accepted.job.id);
  assert.deepEqual(await client.post(`/api/v2/jobs/${accepted.job.id}/cancel`), acceptedHistory.job);
  assert.deepEqual(await client.tool('deviceforge.cancel_job', { id: accepted.job.id }), acceptedHistory.job);
  assert.deepEqual(await history(client, accepted.job.id), acceptedHistory, 'Succeeded之后取消不改写既有历史');
  assert.deepEqual((await client.json('/api/v2/devices')).find((directory) => directory.provider.id === item.id), accepted.directory,
    '此处取消发生在本次回执已完成之后，不撤销已接受目录');
  passed(report, '已接受回执后取消保留Succeeded历史和当前目录', { job_id: accepted.job.id,
    boundary: '不覆盖Succeeded但attempt仍Pending的内部窗口；该窗口关联公共集成与pure门禁测试' });

  const old = item.provider, label = `${item.id}_unload_inflight`;
  await control(item, { label, mode: 'hold' });
  const held = await callEntry(client, old, { entry: 'alias', transport: 'http', alias: item.alias });
  await started(item, label);
  await client.manage(item.id, 'unload');
  const process = await cleaned(item, label, { cancelled: true, atReturn: true });
  await client.finished(held.id, 'cancelled');
  const oldHistory = await history(client, held.id);
  assertOwnerAbsent(await registrations(client), item);
  await assertNoDirectory(client, item.id);
  const rejectedBefore = await jobList(client), keysBefore = await executionKeys(fixtures.all);
  await client.post('/api/v2/jobs', { operation: item.alias, input: {} }, { status: 404, code: 'not_found' });
  await client.tool(item.alias, {}, 'not_found');
  assert.deepEqual(await jobList(client), rejectedBefore);
  assert.deepEqual(await executionKeys(fixtures.all), keysBefore);
  await client.manage(item.id, 'load', 'mcp');
  await providersFor(client, [item]);
  assert.notEqual(item.provider.generation, old.generation);
  const beforeStaleJobs = await jobList(client), beforeStaleKeys = await executionKeys(fixtures.all);
  await client.refresh(old, { status: 409, code: 'conflict' });
  await client.tool('deviceforge.refresh_devices', { id: old.id, generation: old.generation }, 'conflict');
  assert.deepEqual(await jobList(client), beforeStaleJobs, '旧代刷新必须准入前拒绝，零Job');
  assert.deepEqual(await executionKeys(fixtures.all), beforeStaleKeys, '旧代刷新不得执行新代夹具');
  assert.deepEqual(await history(client, held.id), oldHistory, '重载不把历史改绑到新代');
  await oneDiscovery(context, item, { label: `${item.id}_reload_new_discovery`, entry: 'alias', transport: 'mcp' });
  passed(report, '在途热卸载合作清理、贡献撤销、重载新代、旧代精确拒绝及历史保留', {
    old_generation: old.generation, new_generation: item.provider.generation, held_job_id: held.id, process });

  // 已先独立验证profile加载后部署保留；此时显式删除只为重启有效部署集合。
  for (const profile of fixtures.profiles) await client.json(`/api/v2/plugin-packages/server/${profile.id}`, { method: 'DELETE' });
  const jobs = await jobList(client);
  context.restartHistory = [];
  for (const job of jobs) context.restartHistory.push(await history(client, job.id));
  context.restartKeys = await executionKeys(fixtures.all);
  context.restartProviders = [...fixtures.items, fixtures.wide].map((entry) => structuredClone(entry.provider));
}

export async function verifyRestart(context) {
  const { client, fixtures, report } = context;
  assert.deepEqual(await client.json('/api/v2/devices'), [], '真实Rust重启不从Succeeded历史恢复可动作目录');
  assert.deepEqual(await client.tool('deviceforge.list_devices'), []);
  assert.deepEqual(await executionKeys(fixtures.all), context.restartKeys, '真实重启不自动执行发现');
  const current = await client.json('/api/v2/device-providers');
  const valid = [...fixtures.items, fixtures.wide];
  for (const item of valid) if (!current.some((provider) => provider.id === item.id)) await client.manage(item.id, 'load');
  await providersFor(client, valid);
  for (const old of context.restartProviders) {
    const item = valid.find((entry) => entry.id === old.id);
    assert.notEqual(item.provider.generation, old.generation, '重启后的当前owner不能复用历史generation');
    await client.refresh(old, { status: 409, code: 'conflict' });
  }
  const after = await jobList(client);
  assert.deepEqual(after.map((job) => job.id), context.restartHistory.map((entry) => entry.job.id), '重启不创建伪续跑Job');
  for (const recorded of context.restartHistory) assert.deepEqual(await history(client, recorded.job.id), recorded,
    '真实同SQLite重启完整保留Job原结果、原输入、旧原文/旧数组及事件');
  for (const item of fixtures.items.filter((entry) => entry.devicesApiVersion === 3)) {
    const action = { provider_id: item.id, generation: item.provider.generation, device_id: item.localId,
      capability: 'device_read', version: 1, input: {} };
    await client.post('/api/v2/device-actions', action, { status: 409, code: 'conflict' });
    await client.tool('deviceforge.invoke_device', action, 'conflict');
    const renewed = await oneDiscovery(context, item, { label: `${item.id}_after_real_restart`, entry: 'alias', transport: 'http' });
    assert.ok(!context.restartHistory.some((entry) => entry.job.id === renewed.job.id));
  }
  passed(report, '同部署与SQLite真实Rust重启：历史完整、无目录复活、无自动执行、重新发现新Job', {
    persisted_jobs: context.restartHistory.length, host_ordinals: [1, 2], current_directory_is_fresh_observation: true });
}
