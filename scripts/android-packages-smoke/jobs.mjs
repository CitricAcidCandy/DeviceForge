import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { sharedJob, jobEvents } from '../ordinary-deadline-http/client.mjs';
import { apkSample, manifestValue, sha256, storedZip } from './samples.mjs';
import { readyProcesses, releaseProcesses, verifyProcesses } from './process-evidence.mjs';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

function publicMetadata(value) {
  assert.match(value.id, uuid); assert.match(value.sha256, /^[\da-f]{64}$/);
  assert.ok(Number.isSafeInteger(value.size) && value.size >= 0);
  assert.deepEqual(Object.keys(value).sort(), ['created_at', 'filename', 'id', 'media_type', 'sha256', 'size']);
}

async function upload(client, filename, bytes) {
  const metadata = await client.json(`/api/v2/artifacts?filename=${encodeURIComponent(filename)}`, {
    method: 'POST', status: 201, headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  publicMetadata(metadata); assert.equal(metadata.filename, filename);
  assert.equal(metadata.size, bytes.length); assert.equal(metadata.sha256, sha256(bytes));
  return metadata;
}

async function submit(client, report, entry) {
  const before = await client.json('/api/v2/jobs?limit=100');
  const request = client.scope({ case_id: entry.case_id, phase: 'submit' });
  const submitted = entry.transport === 'http'
    ? await request.post('/api/v2/jobs', { operation: entry.operation, input: entry.input }, { status: 202 })
    : await request.tool(entry.operation, entry.input);
  assert.match(submitted.id, uuid); assert.equal(submitted.operation, entry.operation);
  assert.deepEqual(submitted.input, entry.input);
  entry.job_id = submitted.id; entry.submit_log_id = report.last_request.log_id; assert.match(entry.submit_log_id, uuid);
  report.jobs.push(entry);
  const after = await client.json('/api/v2/jobs?limit=100');
  assert.deepEqual(after.filter((item) => !before.some((old) => old.id === item.id)).map((item) => item.id), [entry.job_id],
    '旧alias/新target只能新建一个Job，不得嵌套提交第二份');
}

async function terminal(client, entry) {
  await poll(() => client.job(entry.job_id), (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status),
    '本次安卓包Job有限完成', 15000);
  const job = await sharedJob(client, entry);
  assert.equal(job.status, 'succeeded'); assert.equal(job.error, null);
  entry.events = await jobEvents(client, entry);
  entry.history = job;
  return job;
}

// 下载始终逐块计数；缺少 Content-Length 时也不能无限缓冲。
async function boundedDownload(response, limit) {
  const header = response.headers.get('content-length');
  if (header !== null) {
    assert.match(header, /^\d+$/);
    assert.ok(Number.isSafeInteger(Number(header)) && Number(header) <= limit);
  }
  assert.ok(response.body, '实际下载必须提供正文');
  const reader = response.body.getReader(), chunks = [];
  let length = 0, complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      length += chunk.value.byteLength;
      assert.ok(length <= limit, '实际下载正文超出本组固定样本上限');
      chunks.push(Buffer.from(chunk.value));
    }
    if (header !== null) assert.equal(length, Number(header));
    return Buffer.concat(chunks, length);
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function download(client, report, entry, artifact, expected) {
  publicMetadata(artifact);
  assert.deepEqual(await client.json(`/api/v2/artifacts/${artifact.id}`), artifact);
  const path = `/api/v2/artifacts/${artifact.id}/content`;
  const pending = { case_id: entry.case_id, job_id: entry.job_id, artifact_id: artifact.id, path, method: 'GET', started_at: new Date().toISOString() };
  report.last_request = pending;
  let response;
  try {
    response = await fetch(`${client.base}${path}`, { signal: AbortSignal.timeout(5000) });
    const logId = response.headers.get('x-deviceforge-log-id');
    report.last_request = { ...pending, status: response.status, log_id: logId };
    report.requests.push({ ...report.last_request, outcome: 'returned', phase: 'download' });
    assert.equal(response.status, 200); assert.match(logId, uuid); client.logIds.add(logId);
    const bytes = await boundedDownload(response, 65536);
    assert.deepEqual(bytes, expected); assert.equal(bytes.length, artifact.size);
    assert.equal(sha256(bytes), artifact.sha256);
    entry.download = { artifact_id: artifact.id, log_id: logId, size: bytes.length, sha256: sha256(bytes), original_bytes_equal: true };
  } catch (error) {
    report.failed_request ??= { ...pending, status: response?.status, log_id: response?.headers.get('x-deviceforge-log-id') };
    throw error;
  }
}

export async function verifyFourJobs(host, deployment, report) {
  const client = host.client;
  const baseline = await client.json('/api/v2/jobs?limit=100');
  assert.deepEqual(baseline, [], '独占空数据目录作为本次基线');
  report.jobs_baseline_ids = baseline.map((item) => item.id);
  const manifests = [];
  for (const [transport, alias] of [['http', true], ['mcp', false]]) {
    const caseId = `manifest-${transport}-${alias ? 'alias' : 'target'}`;
    const bytes = apkSample(caseId), source = await upload(client, `${caseId}.apk`, bytes);
    const entry = { case_id: caseId, kind: 'manifest', transport, alias, expected_status: 'succeeded', plugin_id: 'android-packages',
      operation: alias ? 'android.package.manifest' : 'plugin.android-packages.manifest', input: { artifact_id: source.id }, source };
    await submit(client, report, entry); manifests.push(entry);
  }
  await readyProcesses(deployment, manifests, report);
  for (const entry of manifests) {
    assert.equal((await sharedJob(client, entry)).status, 'running', '两工具都ready但尚未release时Job仍Running');
  }
  await releaseProcesses(manifests);
  for (const entry of manifests) {
    const job = await terminal(client, entry), value = manifestValue(entry.source.id);
    if (entry.alias) assert.deepEqual(job.result, value);
    else assert.deepEqual(job.result, { result: value, artifacts: [] });
    entry.result_dto = value;
    report.checks.push({ name: `manifest ${entry.transport} ${entry.alias ? '旧alias' : '新target'} 完整DTO/XML/null`, job_id: entry.job_id, passed: true });
  }
  const expectedApk = apkSample('extract-original');
  const apks = storedZip([['universal.apk', expectedApk], ['toc.pb', Buffer.from('independent-toc')]]);
  const source = await upload(client, 'extract-source.apks', apks);
  for (const [transport, alias] of [['http', false], ['mcp', true]]) {
    const entry = { case_id: `extract-${transport}-${alias ? 'alias' : 'target'}`, kind: 'extract_apk', transport, alias,
      expected_status: 'succeeded', plugin_id: 'android-packages', source,
      operation: alias ? 'android.package.extract_apk' : 'plugin.android-packages.extract_apk',
      input: { artifact_id: source.id, entry: 'universal.apk' },
      direct_plugin_pid_observed: false, pid_boundary: '无外部工具；仅同Job/request/log关联，不虚构插件OS PID' };
    await submit(client, report, entry);
    const job = await terminal(client, entry);
    let artifact;
    if (alias) {
      assert.deepEqual(Object.keys(job.result).sort(), ['artifact', 'entry', 'source_artifact_id']);
      assert.equal(job.result.source_artifact_id, source.id); assert.equal(job.result.entry, 'universal.apk');
      artifact = job.result.artifact;
    } else {
      assert.deepEqual(Object.keys(job.result).sort(), ['artifacts', 'result']);
      assert.deepEqual(job.result.result, { entry: 'universal.apk' }); assert.equal(job.result.artifacts.length, 1);
      artifact = job.result.artifacts[0];
    }
    assert.equal(artifact.filename, 'extracted.apk'); assert.notEqual(artifact.id, source.id);
    await download(client, report, entry, artifact, expectedApk);
    entry.host_artifact = artifact;
    report.checks.push({ name: `extract_apk ${transport} ${alias ? '旧alias投影' : '新target包装'} 实际Artifact下载字节`, job_id: entry.job_id, passed: true });
  }
  assert.equal(new Set(report.jobs.map((entry) => entry.job_id)).size, 4);
  const history = await client.json('/api/v2/jobs?limit=100');
  assert.deepEqual(history.map((job) => job.id).sort(), report.jobs.map((entry) => entry.job_id).sort());
  for (const entry of report.jobs) assert.deepEqual(history.find((job) => job.id === entry.job_id), await sharedJob(client, entry));
  await verifyProcesses(deployment, manifests);
  report.checks.push({ name: '同Job历史/唯一终态、两真实工具父插件PID退出、两个extract零额外工具与scratch清空', passed: true });
}
