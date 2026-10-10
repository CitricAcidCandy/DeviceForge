import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { actionInput } from '../device-provider/discovery.mjs';
import { cleaned, control, events, localId, operation, release, started } from '../device-provider/fixtures.mjs';
import { names } from './config.mjs';

export async function hidden(client, aliases) {
  const http = (await client.json('/api/v2/operations')).map((entry) => entry.id);
  const mcp = await client.tools();
  for (const alias of aliases) {
    assert.ok(!http.includes(alias), '未加载目标的别名不发布到 HTTP');
    assert.ok(!mcp.includes(alias), '未加载目标的别名不发布到 MCP');
    const input = { device_id: localId, label: 'hidden' };
    await client.post('/api/v2/jobs', { operation: alias, input }, { status: 404, code: 'not_found' });
    await client.tool(alias, input, 'not_found');
  }
}

async function submit(client, alias, input, transport = 'http') {
  const before = await client.json('/api/v2/jobs?limit=100');
  const job = transport === 'http'
    ? await client.post('/api/v2/jobs', { operation: alias, input }, { status: 202 }) : await client.tool(alias, input);
  const after = await client.json('/api/v2/jobs?limit=100');
  assert.deepEqual(after.filter((entry) => !before.some((old) => old.id === entry.id)).map((entry) => entry.id), [job.id],
    '旧入口只能创建一份 Job，不能为真实目标嵌套提交');
  assert.equal(job.operation, alias); assert.deepEqual(job.input, input);
  return job;
}

async function complete(client, first, job, input, status = 'succeeded') {
  const terminal = await client.finished(job.id, status);
  assert.equal(terminal.operation, job.operation); assert.deepEqual(terminal.input, input);
  await cleaned(first, input.label ?? input.input.label);
  return terminal;
}

async function rejectedLoadSnapshot(client, bad, transport) {
  const prefix = `plugin.${bad.id}.`;
  const httpOperations = (await client.json('/api/v2/operations')).map((entry) => entry.id)
    .filter((id) => id.startsWith(prefix));
  assert.deepEqual(httpOperations, [], '错误绑定加载失败后 HTTP 不得留下原操作');
  const mcpTools = (await client.tools()).filter((name) => name.startsWith(prefix));
  assert.deepEqual(mcpTools, [], '错误绑定加载失败后 MCP 不得留下原工具');
  const httpProviders = await client.json('/api/v2/device-providers');
  const httpRegistered = httpProviders.some((provider) => provider.id === bad.id);
  assert.equal(httpRegistered, false, '错误绑定加载失败后 HTTP 不得留下提供者');
  const mcpProviders = await client.tool('deviceforge.list_device_providers');
  const mcpRegistered = mcpProviders.some((provider) => provider.id === bad.id);
  assert.equal(mcpRegistered, false, '错误绑定加载失败后 MCP 不得留下提供者');
  return { plugin_id: bad.id, load_transport: transport, http_original_operations: httpOperations,
    mcp_original_tools: mcpTools, http_provider_registered: httpRegistered, mcp_provider_registered: mcpRegistered };
}

export async function verify({ client, first, bad, ordinary, report }) {
  await hidden(client, Object.values(names));
  for (const item of [first, ordinary, bad]) {
    const installed = await client.json('/api/v2/plugin-packages/server?format=tgz', { method: 'POST', status: 201,
      headers: { 'content-type': 'application/gzip' }, body: item.archive });
    assert.equal(installed.id, item.id);
  }
  await client.manage(first.id, 'load'); await client.manage(ordinary.id, 'load', 'mcp');
  report.rejected_load_snapshots = [];
  await client.post(`/api/v2/plugins/${bad.id}/load`, undefined, { status: 400, code: 'invalid_input' });
  report.rejected_load_snapshots.push(await rejectedLoadSnapshot(client, bad, 'http'));
  await client.tool('deviceforge.load_plugin', { id: bad.id }, 'invalid_input');
  report.rejected_load_snapshots.push(await rejectedLoadSnapshot(client, bad, 'mcp'));
  const all = (await client.json('/api/v2/operations')).map((entry) => entry.id);
  await hidden(client, [names.missing, names.bad]);
  for (const name of [names.device, names.provider, names.ordinary, names.result]) {
    assert.ok(all.includes(name)); assert.ok((await client.tools()).includes(name));
  }
  report.checks.push({ name: '显式预留旧内置入口、缺目标无回退、普通目标不能绕发现、加载拒绝后HTTP/MCP无贡献残留', passed: true });
  first.provider = (await client.json('/api/v2/device-providers')).find((provider) => provider.id === first.id);
  const unobserved = { device_id: localId, label: 'unobserved' };
  await client.post('/api/v2/jobs', { operation: names.device, input: unobserved }, { status: 409, code: 'conflict' });
  await client.tool(names.device, unobserved, 'conflict');
  await control(first, 'valid', 'alias-discovery'); await client.refresh(first.provider);
  report.provider = first.provider;
  report.history_jobs = [];
  for (const transport of ['http', 'mcp']) {
    const input = { device_id: localId, label: `alias-basic-${transport}` };
    const job = await submit(client, names.device, input, transport);
    const terminal = await complete(client, first, job, input);
    assert.equal(terminal.result.device_id, localId); assert.equal(terminal.result.operation, 'device_write');
    assert.equal(terminal.result.label, input.label); report.history_jobs.push(job.id);
  }
  const providerInput = { label: 'provider-projection' };
  const providerJob = await submit(client, names.provider, providerInput, 'mcp');
  assert.deepEqual((await complete(client, first, providerJob, providerInput)).result,
    { label: providerInput.label, provider_id: first.id, device_id: null });
  const forbidden = { ...providerInput, device_id: localId };
  await client.post('/api/v2/jobs', { operation: names.provider, input: forbidden }, { status: 400, code: 'invalid_input' });
  await client.tool(names.provider, forbidden, 'invalid_input');
  const plain = { device_id: null, input: { label: 'plain-identity' } };
  const plainJob = await submit(client, names.ordinary, plain);
  assert.equal((await complete(client, ordinary, plainJob, plain)).result.operation, 'echo');
  const badInput = { device_id: localId, label: 'required-result-missing' };
  const badJob = await submit(client, names.result, badInput);
  assert.match((await complete(client, first, badJob, badInput, 'failed')).error, /结果投影缺少必填源/);
  report.checks.push({ name: 'HTTP/MCP单Job、原输入和旧名称保留、真实目标封套、普通贡献与可选结果投影', passed: true });
}

export async function verifyLifecycle({ client, first, report }) {
  const input = { device_id: localId, label: 'alias-lock-first', gate: true, duration_ms: 12000 };
  const firstJob = await submit(client, names.device, input);
  await started(first, input.label);
  const targetInput = { label: 'alias-lock-target' };
  const direct = await client.action(actionInput(first.provider, 'device_write', localId, targetInput), 'mcp');
  await delay(75);
  assert.equal((await client.job(direct.id)).status, 'queued');
  assert.ok(!(await events(first)).some((event) => event.kind === 'started' && event.label === targetInput.label));
  await release(first, input.label);
  await complete(client, first, firstJob, input);
  await complete(client, first, direct, { device_id: localId, input: targetInput });
  const observed = await events(first);
  assert.ok(observed.findIndex((event) => event.kind === 'started' && event.label === targetInput.label)
    > observed.findIndex((event) => event.kind === 'cleaned' && event.label === input.label));
  report.checks.push({ name: '旧别名与新能力同设备写锁共享，门闩与真实进程事件证明串行', passed: true });

  const cancellation = { device_id: localId, label: 'alias-explicit-cancel', gate: true, duration_ms: 12000 };
  const cancelled = await submit(client, names.device, cancellation, 'mcp');
  await started(first, cancellation.label);
  assert.equal((await client.tool('deviceforge.cancel_job', { id: cancelled.id })).status, 'cancelled');
  await client.finished(cancelled.id, 'cancelled');
  await cleaned(first, cancellation.label, { cancelled: true });
  report.checks.push({ name: '旧别名显式取消使用真实协议3清理并退出', passed: true });

  const historical = await client.job(report.history_jobs[0]);
  const generation = first.provider.generation;
  const activeInput = { device_id: localId, label: 'alias-unload-active', gate: true, duration_ms: 12000 };
  const active = await submit(client, names.device, activeInput);
  await started(first, activeInput.label);
  const queuedInput = { device_id: localId, label: 'alias-unload-queued' };
  const queued = await submit(client, names.device, queuedInput, 'mcp');
  const detached = await client.manage(first.id, 'unload', 'mcp');
  assert.equal(detached.state, 'unloaded'); assert.equal(detached.cleanup_failed, false);
  await cleaned(first, activeInput.label, { cancelled: true, atReturn: true });
  await client.finished(active.id, 'cancelled'); await client.finished(queued.id, 'cancelled');
  assert.ok(!(await events(first)).some((event) => event.kind === 'started' && event.label === queuedInput.label));
  await hidden(client, [names.device, names.provider, names.result]);
  assert.ok(!(await client.tools()).some((name) => name.startsWith(`plugin.${first.id}.`)));
  const loaded = await client.manage(first.id, 'load');
  assert.notEqual(loaded.generation, generation);
  const old = first.provider;
  first.provider = (await client.json('/api/v2/device-providers')).find((provider) => provider.id === first.id);
  await client.tool('deviceforge.invoke_device', actionInput(old, 'device_write', localId, { label: 'old-generation' }), 'conflict');
  await client.post('/api/v2/jobs', { operation: names.device, input: queuedInput }, { status: 409, code: 'conflict' });
  await control(first, 'valid', 'alias-reload-discovery'); await client.refresh(first.provider);
  const reloadedInput = { device_id: localId, label: 'alias-reloaded' };
  const reloaded = await submit(client, names.device, reloadedInput, 'mcp');
  await complete(client, first, reloaded, reloadedInput);
  assert.deepEqual(await client.job(historical.id), historical, '卸载重载不能改写旧 Job');
  // 这里只采样管理返回后的公开入口，中间注册快照原子性由独立 Rust 集成验证。
  report.checks.push({ name: '卸载返回后别名与原贡献不可见、取消排队零执行、重载新代且历史保留', passed: true,
    atomicity_evidence: { suite: 'backend/crates/application/tests/operation_aliases.rs', tests: 17,
      scope: '独立集成验证；本脚本不重验或推定该批结果' },
    old_generation: generation, new_generation: loaded.generation });
}

export async function verifyArtifacts({ client, artifacts, report }) {
  const published = [];
  for (const item of artifacts) {
    await client.json('/api/v2/plugin-packages/server?format=tgz', { method: 'POST', status: 201,
      headers: { 'content-type': 'application/gzip' }, body: item.archive });
    await client.manage(item.id, 'load');
    const input = { label: `published-artifact-${item.protocol}` };
    const job = await submit(client, `legacy.artifact_${item.protocol}`, input, item.protocol === 2 ? 'http' : 'mcp');
    const terminal = await complete(client, item, job, input);
    const metadata = terminal.result;
    assert.equal(metadata.filename, 'result.json'); assert.notEqual(metadata.id, 'forged-business-id');
    assert.deepEqual(await client.json(`/api/v2/artifacts/${metadata.id}`), metadata);
    const path = `/api/v2/artifacts/${metadata.id}/content`;
    const before = performance.now();
    report.last_request = { path, method: 'GET', started_at: new Date().toISOString() };
    const response = await fetch(`${client.base}${path}`, { signal: AbortSignal.timeout(3000) });
    const logId = response.headers.get('x-deviceforge-log-id');
    report.last_request = { path, method: 'GET', status: response.status, log_id: logId,
      elapsed_ms: performance.now() - before };
    assert.equal(response.status, 200);
    assert.match(logId, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
    client.logIds.add(logId);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString('utf8'), '{"published":"真实宿主产物"}\n');
    assert.equal(bytes.length, metadata.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
    published.push({ protocol_version: item.protocol, job_id: job.id, artifact_id: metadata.id,
      sha256: metadata.sha256, download_log_id: logId });
  }
  report.checks.push({ name: '协议2/3真实输出由宿主发布、命名投影元数据与下载摘要一致、不取业务伪造ID', passed: true, published });
}
