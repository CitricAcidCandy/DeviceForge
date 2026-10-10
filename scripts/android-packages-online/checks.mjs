import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { sharedJob, jobEvents } from '../ordinary-deadline-http/client.mjs';
import { apkSample, sha256, storedZip } from '../android-packages-smoke/samples.mjs';
import { pluginId, suffixes } from './deployment.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;

export async function catalog(host, context, report, phase, available) {
  const http = await host.client.json('/api/v2/operations');
  assert.deepEqual(await host.client.tool('deviceforge.list_operations'), http);
  const tools = new Set(await host.client.tools()), ids = new Set(http.map((item) => item.id));
  const observed = [];
  for (const [index, suffix] of suffixes.entries()) {
    const alias = `android.package.${suffix}`, target = `plugin.${pluginId}.${suffix}`;
    for (const id of [alias, target]) {
      assert.equal(ids.has(id), available, `HTTP贡献 ${phase} ${id}`);
      assert.equal(tools.has(id), available, `MCP贡献 ${phase} ${id}`);
    }
    if (available) {
      const old = http.filter((item) => item.id === alias), direct = http.filter((item) => item.id === target);
      assert.equal(old.length, 1); assert.equal(direct.length, 1);
      assert.deepEqual(old[0].input_schema, direct[0].input_schema);
      const expected = { ...context.manifest.operations[index].execution, source: 'declared' };
      assert.deepEqual(direct[0].execution, expected); assert.deepEqual(old[0].execution, expected);
      observed.push({ alias, target, execution: expected });
    }
  }
  report.catalog_phases ??= [];
  report.catalog_phases.push({ phase, available, operations: observed,
    boundary: '仅当前端点采样；其它五业务未执行，也不证明注册原子性' });
}

export async function plugins(host, expected) {
  const http = await host.client.json('/api/v2/plugins');
  assert.deepEqual(await host.client.tool('deviceforge.list_plugins'), http);
  if (expected) {
    assert.equal(http.length, 1); assert.deepEqual(http[0], expected);
  } else assert.deepEqual(http, []);
}

function metadata(value) {
  assert.deepEqual(Object.keys(value).sort(), ['created_at', 'filename', 'id', 'media_type', 'sha256', 'size']);
  assert.match(value.id, uuid); assert.match(value.sha256, /^[a-f\d]{64}$/);
  assert.ok(Number.isSafeInteger(value.size) && value.size >= 0);
}

async function upload(client, filename, bytes) {
  const value = await client.json(`/api/v2/artifacts?filename=${encodeURIComponent(filename)}`, {
    method: 'POST', status: 201, headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  metadata(value); assert.equal(value.filename, filename);
  assert.equal(value.size, bytes.length); assert.equal(value.sha256, sha256(bytes));
  return value;
}

async function submit(host, report, entry) {
  const before = await host.client.json('/api/v2/jobs?limit=100');
  const request = host.client.scope({ case_id: entry.case_id, phase: 'submit' });
  const submitted = entry.transport === 'http'
    ? await request.post('/api/v2/jobs', { operation: entry.operation, input: entry.input }, { status: 202 })
    : await request.tool(entry.operation, entry.input);
  assert.match(submitted.id, uuid); assert.equal(submitted.operation, entry.operation); assert.deepEqual(submitted.input, entry.input);
  entry.job_id = submitted.id; entry.submit_log_id = report.last_request.log_id; assert.match(entry.submit_log_id, uuid);
  report.jobs.push(entry);
  const after = await host.client.json('/api/v2/jobs?limit=100');
  assert.deepEqual(after.filter((item) => !before.some((old) => old.id === item.id)).map((item) => item.id), [entry.job_id]);
  await poll(() => host.client.job(entry.job_id), (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status),
    '本次无工具原包任务完成', 15000);
  const completed = await sharedJob(host.client, entry);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.error, null);
  entry.events = await jobEvents(host.client, entry); entry.history = completed;
  return completed;
}

async function download(host, directory, report, entry, artifact, expected) {
  metadata(artifact); assert.deepEqual(await host.client.json(`/api/v2/artifacts/${artifact.id}`), artifact);
  const path = `/api/v2/artifacts/${artifact.id}/content`;
  const pending = { case_id: entry.case_id, job_id: entry.job_id, artifact_id: artifact.id,
    path, method: 'GET', phase: 'download', started_at: new Date().toISOString() };
  report.last_request = pending;
  let response;
  try {
    response = await fetch(`${host.client.base}${path}`, { signal: AbortSignal.timeout(5000) });
    const logId = response.headers.get('x-deviceforge-log-id');
    report.last_request = { ...pending, status: response.status, log_id: logId };
    report.requests.push({ ...report.last_request, outcome: 'returned' });
    assert.equal(response.status, 200); assert.match(logId, uuid); host.client.logIds.add(logId);
    const declared = response.headers.get('content-length');
    assert.match(declared, /^\d+$/); assert.equal(Number(declared), expected.length);
    assert.ok(expected.length <= 65536 && response.body);
    const reader = response.body.getReader(), chunks = [];
    let length = 0, complete = false;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) { complete = true; break; }
        length += chunk.value.byteLength; assert.ok(length <= 65536);
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, length);
    assert.deepEqual(bytes, expected); assert.equal(bytes.length, artifact.size); assert.equal(sha256(bytes), artifact.sha256);
    const retainedPath = join(directory, `${entry.case_id}-download.apk`);
    await writeFile(retainedPath, bytes, { flag: 'wx' });
    entry.download = { artifact_id: artifact.id, log_id: logId, retained_path: retainedPath,
      sha256: sha256(bytes), size: bytes.length, original_bytes_equal: true };
  } catch (error) {
    report.failed_request ??= { ...pending, status: response?.status, log_id: response?.headers.get('x-deviceforge-log-id') };
    throw error;
  }
}

function scanSample() {
  const evidence = ['smali/org/smoke/sdk/Entry.smali', 'smali_classes2/org/smoke/sdk/Extra.smali'];
  const rules = [
    { name: '命中类', package_path: 'org.smoke.sdk', class_name: 'Entry' },
    { name: '缺失类', package_path: 'org.smoke.sdk', class_name: 'Missing' },
    { name: '只查包', package_path: 'org.smoke.sdk', class_name: null },
  ];
  const bytes = storedZip([
    ['apktool.yml', Buffer.from('version: 2.9.0\n')],
    ['AndroidManifest.xml', Buffer.from('<manifest package="org.smoke.sdk"/>')],
    [evidence[0], Buffer.from('.class public Lorg/smoke/sdk/Entry;\n')],
    [evidence[1], Buffer.from('.class public Lorg/smoke/sdk/Extra;\n')],
  ]);
  // 固定独立期望，不调用公共核心解析器生成自身断言。
  const findings = rules.map((rule, index) => ({ rule, package_found: true,
    class_found: [true, false, null][index], evidence: [...evidence] }));
  return { bytes, rules, findings };
}

export async function fourJobs(host, directory, report) {
  const baseline = await host.client.json('/api/v2/jobs?limit=100');
  assert.deepEqual(baseline, []); report.jobs_baseline_ids = [];
  const originalApk = apkSample('online-extract-original');
  const apks = storedZip([['universal.apk', originalApk], ['toc.pb', Buffer.from('independent-online-toc')]]);
  const scan = scanSample();
  await writeFile(join(directory, 'expected-original.apk'), originalApk, { flag: 'wx' });
  await writeFile(join(directory, 'input-original.apks'), apks, { flag: 'wx' });
  await writeFile(join(directory, 'input-decoded.zip'), scan.bytes, { flag: 'wx' });
  const apksSource = await upload(host.client, 'online-original.apks', apks);
  const scanSource = await upload(host.client, 'online-decoded.zip', scan.bytes);
  report.samples = { apks: { artifact: apksSource, sha256: sha256(apks) },
    decoded: { artifact: scanSource, sha256: sha256(scan.bytes), rules: scan.rules },
    extracted_original: { size: originalApk.length, sha256: sha256(originalApk) } };
  for (const [transport, alias] of [['http', true], ['mcp', false]]) {
    const entry = { case_id: `extract-${transport}-${alias ? 'alias' : 'target'}`, transport, alias,
      kind: 'extract_apk', plugin_id: pluginId, expected_status: 'succeeded', source: apksSource,
      operation: alias ? 'android.package.extract_apk' : `plugin.${pluginId}.extract_apk`,
      input: { artifact_id: apksSource.id, entry: 'universal.apk' }, direct_plugin_pid_observed: false };
    const job = await submit(host, report, entry);
    let artifact;
    if (alias) {
      assert.deepEqual(Object.keys(job.result).sort(), ['artifact', 'entry', 'source_artifact_id']);
      assert.equal(job.result.source_artifact_id, apksSource.id); assert.equal(job.result.entry, 'universal.apk');
      artifact = job.result.artifact;
    } else {
      assert.deepEqual(Object.keys(job.result).sort(), ['artifacts', 'result']);
      assert.deepEqual(job.result.result, { entry: 'universal.apk' }); assert.equal(job.result.artifacts.length, 1);
      artifact = job.result.artifacts[0];
    }
    assert.equal(artifact.filename, 'extracted.apk'); assert.notEqual(artifact.id, apksSource.id);
    await download(host, directory, report, entry, artifact, originalApk);
    entry.host_artifact = artifact;
    report.checks.push({ name: `原TGZ ${entry.case_id} 同Job旧/新结果与实际下载原字节`, passed: true, job_id: entry.job_id });
  }
  assert.notEqual(report.jobs[0].host_artifact.id, report.jobs[1].host_artifact.id,
    '两次调用各自实际发布，不能借另一个Job产物充数');
  for (const [transport, alias] of [['http', false], ['mcp', true]]) {
    const entry = { case_id: `scan-${transport}-${alias ? 'alias' : 'target'}`, transport, alias,
      kind: 'scan_sdks', plugin_id: pluginId, expected_status: 'succeeded', source: scanSource,
      operation: alias ? 'android.package.scan_sdks' : `plugin.${pluginId}.scan_sdks`,
      input: { artifact_id: scanSource.id, rules: scan.rules }, direct_plugin_pid_observed: false };
    const job = await submit(host, report, entry);
    const value = { artifact_id: scanSource.id, findings: scan.findings };
    assert.deepEqual(job.result, alias ? value : { result: value, artifacts: [] });
    entry.result_dto = value;
    report.checks.push({ name: `原TGZ ${entry.case_id} 完整SDK命中/缺失/null/证据排序`, passed: true, job_id: entry.job_id });
  }
  assert.equal(report.jobs.length, 4); assert.equal(new Set(report.jobs.map((entry) => entry.job_id)).size, 4);
  await preservedHistory(host, report, '四Job完成');
}

export async function preservedHistory(host, report, phase) {
  const listed = await host.client.json('/api/v2/jobs?limit=100');
  assert.deepEqual(listed.map((job) => job.id).sort(), report.jobs.map((entry) => entry.job_id).sort(),
    '装卸/管理不得产生额外Job，旧alias不得嵌套创建任务');
  for (const entry of report.jobs) {
    const job = await sharedJob(host.client, entry);
    assert.deepEqual(job, entry.history); assert.deepEqual(listed.find((item) => item.id === entry.job_id), entry.history);
    assert.deepEqual(await jobEvents(host.client, entry), entry.events);
  }
  report.history_phases ??= [];
  report.history_phases.push({ phase, ids: listed.map((job) => job.id).sort(), unchanged: true });
}
