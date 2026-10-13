import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { assertDirectory } from '../unified-discovery-smoke/observations.mjs';
import { jobList, record, submit } from '../harmony-device-smoke/jobs.mjs';
import { alias, assertScreenshotResult, deviceCapabilities, jpeg, localId, operation, otherId, pluginId, uuid } from './contracts.mjs';
import { advance, callCount, configureHdc, finishTools, prepareTool, readyCall, release, remoteRoot } from './fixtures.mjs';

export const action = (provider, device = localId, input = {}) => ({
  provider_id: provider.id, generation: provider.generation, device_id: device, capability: 'screenshot', version: 1, input,
});

export async function submitScreenshot(host, report, caseId, { point = 'capability', transport = 'http', device = localId } = {}) {
  if (point === 'alias') return submit(host, report, caseId, alias('screenshot'), { device_id: device }, transport);
  if (point === 'direct') return submit(host, report, caseId, operation('screenshot'), { device_id: device, input: {} }, transport);
  assert.equal(point, 'capability'); report.active_case_id = caseId;
  const observed = host.client.scope({ case_id: caseId, phase: 'submit' });
  const request = action(report.provider, device);
  const submitted = transport === 'http'
    ? await observed.post('/api/v2/device-actions', request, { status: 202 })
    : await observed.tool('deviceforge.invoke_device', request);
  assert.match(submitted.id, uuid); assert.match(report.last_request.log_id, uuid);
  const entry = { case_id: caseId, operation: operation('screenshot'), input: { device_id: device, input: {} }, transport,
    job_id: submitted.id, submit_log_id: report.last_request.log_id, expected_status: 'succeeded' };
  report.jobs.push(entry); return entry;
}

export async function discover(host, deployment, report, options, phase = 'first') {
  const fixture = await prepareTool(options.directory, options.toolBinary, report, {
    label: phase + '-discovery', screenshot: false, inputQualification: true,
  });
  await configureHdc(deployment, fixture, report);
  const entry = await submit(host, report, phase + '-发现', operation('discover'), {});
  await readyCall(fixture, 1, { probeBinary: options.probeBinary }); await release(fixture, 1);
  const job = await record(host, entry); assert.equal(job.error, null);
  const raw = [localId, otherId].map((id) => ({ id, state: 'online', raw_state: 'device',
    capabilities: deviceCapabilities.map((id) => ({ id, version: 1, available: true })) }));
  assert.deepEqual(job.result, { result: raw, artifacts: [] });
  const directories = await poll(() => host.client.json('/api/v2/devices'),
    (value) => value.some((item) => item.provider.id === pluginId && item.discovery_job_id === entry.job_id), '本次设备目录');
  assert.deepEqual(await host.client.tool('deviceforge.list_devices'), directories);
  const directory = directories.find((item) => item.provider.id === pluginId);
  const expected = [localId, otherId].map((local_id) => ({ local_id, state: 'online', raw_state: 'device',
    capabilities: deviceCapabilities.map((id) => ({ id, version: 1, available: true, reason: null })) }));
  assertDirectory(directory, report.provider, expected, entry.job_id);
  assert.equal(await callCount(fixture), 5);
  for (const ordinal of [2, 3, 4, 5]) {
    const call = join(fixture.toolRoot, `call-${String(ordinal).padStart(2, '0')}`);
    assert.deepEqual(await readFile(join(call, 'input-argv-verified')), Buffer.from('1'));
    assert.equal(await readFile(join(call, 'normal-exit-code'), 'utf8'), '0');
  }
  entry.tools = await finishTools(fixture); entry.directory = directory;
  report.checks.push({ name: phase + ' 两设备各九availability，含四次输入资格探测，与十一声明能力独立核对', passed: true, job_id: entry.job_id });
}

export async function emptyPrivate(fixture) {
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
  await assert.rejects(lstat(remoteRoot(fixture)), { code: 'ENOENT' });
}

export async function normalEntries(host, deployment, report, options, phase = 'normal') {
  const entries = options.entries ?? ['http', 'mcp'].flatMap((transport) => ['capability', 'direct', 'alias'].map((point) => [transport, point]));
  for (const [transport, point] of entries) {
    const caseId = phase + '-' + transport + '-' + point;
    const fixture = await prepareTool(options.directory, options.toolBinary, report, { label: caseId });
    await configureHdc(deployment, fixture, report);
    const before = new Set((await jobList(host)).map((entry) => entry.id));
    const entry = await submitScreenshot(host, report, caseId, { point, transport });
    await advance(fixture, 5, { probeBinary: options.probeBinary });
    const job = await record(host, entry); assert.equal(job.error, null);
    assert.deepEqual((await jobList(host)).filter((entry) => !before.has(entry.id)).map((entry) => entry.id), [entry.job_id]);
    const metadata = assertScreenshotResult(job.result); assert.equal(metadata.sha256, createHash('sha256').update(jpeg).digest('hex'));
    assert.equal(await callCount(fixture), 5); entry.tools = await finishTools(fixture);
    for (const tool of entry.tools) {
      assert.equal(tool.process.exit.target.state, 'exited'); assert.equal(tool.process.exit.target.exit_code, 0);
      assert.equal(tool.process.exit.parent.state, 'exited'); assert.equal(tool.process.exit.parent.exit_code, 0);
      assert.equal(tool.process.ready.parent.pid, entry.tools[0].process.ready.parent.pid);
    }
    await emptyPrivate(fixture); await download(host, report, entry, metadata, options.token);
    report.checks.push({ name: caseId + ' 唯一Job、五固定argv、完整产物数组、真实父子OS退出及原字节下载', passed: true, job_id: entry.job_id });
  }
}

export async function download(host, report, entry, metadata, token) {
  assert.deepEqual(await host.client.json('/api/v2/artifacts/' + metadata.id), metadata);
  const observed = host.client.scope({ case_id: entry.case_id + '-metadata', phase: 'mcp-metadata' });
  const submitted = await observed.tool('artifact.inspect', { artifact_id: metadata.id }); assert.match(submitted.id, uuid);
  const metadataJob = { case_id: entry.case_id + '-metadata', operation: 'artifact.inspect', input: { artifact_id: metadata.id },
    transport: 'mcp', job_id: submitted.id, submit_log_id: report.last_request.log_id, expected_status: 'succeeded' };
  const job = await record(host, metadataJob); assert.equal(job.error, null); assert.deepEqual(job.result, metadata);
  report.metadata_jobs ??= []; report.metadata_jobs.push(metadataJob);
  const path = '/api/v2/artifacts/' + metadata.id + '/content';
  const response = await fetch(host.client.base + path, { signal: AbortSignal.timeout(5000),
    headers: token ? { authorization: 'Bearer ' + token } : {} });
  const logId = response.headers.get('x-deviceforge-log-id'); assert.match(logId, uuid);
  host.client.logIds.add(logId); report.requests.push({ case_id: entry.case_id, phase: 'download',
    path, method: 'GET', status: response.status, log_id: logId, outcome: 'returned' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(Number(response.headers.get('content-length')), jpeg.length);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const reader = response.body.getReader(), chunks = []; let length = 0, complete = false;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) { complete = true; break; }
      length += item.value.byteLength; assert.ok(length <= jpeg.length); chunks.push(Buffer.from(item.value));
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, length); assert.deepEqual(bytes, jpeg);
  const digest = createHash('sha256').update(bytes).digest('hex'); assert.equal(metadata.sha256, digest);
  entry.download = { artifact_id: metadata.id, log_id: logId, size: length, sha256: digest,
    original_bytes_equal: true, mcp_metadata_job: metadataJob.job_id,
    boundary: 'HTTP下载原字节；MCP artifact.inspect验证同一元数据与共享历史，不提供MCP字节下载接口' };
}

export async function inputErrors(host, deployment, report, options) {
  const fixture = await prepareTool(options.directory, options.toolBinary, report, { label: 'input-reject' });
  await configureHdc(deployment, fixture, report); assert.equal(await callCount(fixture), 0);
  const before = await jobList(host);
  for (const input of [null, [], { path: '/data/local/tmp/user-path' }, { artifact_id: '00000000-0000-4000-8000-000000000000' }]) {
    const observed = host.client.scope({ case_id: 'screenshot-input-reject', phase: 'reject' });
    await observed.post('/api/v2/device-actions', action(report.provider, localId, input), { status: 400, code: 'invalid_input' });
    await observed.tool('deviceforge.invoke_device', action(report.provider, localId, input), 'invalid_input');
    await observed.post('/api/v2/jobs', { operation: operation('screenshot'), input: { device_id: localId, input } },
      { status: 400, code: 'invalid_input' });
    await observed.tool(operation('screenshot'), { device_id: localId, input }, 'invalid_input');
  }
  for (const input of [{}, { device_id: localId, extra: true }, { device_id: localId, input: {} }, { device_id: null }]) {
    await host.client.post('/api/v2/jobs', { operation: alias('screenshot'), input }, { status: 400, code: 'invalid_input' });
    await host.client.tool(alias('screenshot'), input, 'invalid_input');
  }
  assert.deepEqual(await jobList(host), before);
  assert.equal(await callCount(fixture), 0); assert.deepEqual(await readdir(fixture.scratchRoot), []);
  report.checks.push({ name: 'HTTP/MCP三入口严格业务输入与输入产物拒绝，零新增Job及零工具', passed: true });
}

export async function knownFailure(host, deployment, report, options) {
  const fixture = await prepareTool(options.directory, options.toolBinary, report, { label: 'known-jpeg-failure' });
  await writeFile(join(fixture.toolRoot, 'screenshot-source.jpeg'), jpeg.subarray(0, jpeg.length - 1));
  await configureHdc(deployment, fixture, report);
  const entry = await submitScreenshot(host, report, 'known-jpeg-failure', { point: 'alias', transport: 'mcp' });
  await advance(fixture, 5, { probeBinary: options.probeBinary }); await record(host, entry, 'failed');
  assert.equal(entry.history.result, null);
  assert.equal(entry.history.error, '依赖执行失败：输入无效：JPEG结构无效、截断或包含尾随内容');
  assert.equal(await callCount(fixture), 5); entry.tools = await finishTools(fixture); await emptyPrivate(fixture);
  report.checks.push({ name: '已确认reader后的坏JPEG真实失败，远端与私有资源清理完成且零产物发布', passed: true, job_id: entry.job_id });
}

export async function ordinaryOutput(host, deployment, report, options) {
  const fixture = await prepareTool(options.directory, options.toolBinary, report, { label: 'ordinary-packages', screenshot: false });
  await writeFile(join(fixture.toolRoot, 'stdout'), 'com.alpha.app\ncom.beta.app\n');
  await configureHdc(deployment, fixture, report);
  const entry = await submit(host, report, 'ordinary-packages-empty-artifacts', operation('packages'), { device_id: localId, input: {} }, 'mcp');
  await readyCall(fixture, 1, { probeBinary: options.probeBinary, expected: ['-t', localId, 'shell', 'bm', 'dump', '-a'] });
  await release(fixture, 1); await record(host, entry);
  assert.deepEqual(entry.history.result, { result: { output: 'com.alpha.app\ncom.beta.app' }, artifacts: [] });
  assert.equal(await callCount(fixture), 1); entry.tools = await finishTools(fixture);
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
  report.checks.push({ name: '插件全局outputs=true后packages与发现仍空产物；其余旧业务不由本用例代验', passed: true, job_id: entry.job_id });
}
