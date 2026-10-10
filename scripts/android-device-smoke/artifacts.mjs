import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep, toNamespacedPath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apkSample } from '../android-packages-smoke/samples.mjs';
import { action, envelope, submitAction } from './actions.mjs';
import { alias, operation } from './deployment.mjs';
import { finishedTool, keys, localId, observations, release, setMode, started } from './fixtures.mjs';
import { jobList, record, submit, uuid } from './jobs.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function metadata(value) {
  assert.match(value.id, uuid); assert.match(value.sha256, /^[a-f\d]{64}$/);
  assert.deepEqual(Object.keys(value).sort(), ['created_at', 'filename', 'id', 'media_type', 'sha256', 'size']);
  assert.ok(Number.isSafeInteger(value.size) && value.size >= 0);
}
export async function emptyScratch(fixture) {
  assert.deepEqual(await readdir(fixture.scratchRoot), [], 'AD-SCRATCH-EMPTY');
}
async function upload(host, report) {
  const bytes = apkSample('android-device-install');
  report.active_case_id = '上传安卓安装源';
  const source = await host.client.scope({ case_id: '上传安卓安装源', phase: 'upload' })
    .json('/api/v2/artifacts?filename=' + encodeURIComponent('独立测试.apk'), { method: 'POST', status: 201,
      headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  metadata(source); assert.equal(source.filename, '独立测试.apk');
  assert.equal(source.size, bytes.length); assert.equal(source.sha256, hash(bytes));
  report.artifact_sources = [{ metadata: source, bytes: bytes.length, sha256: hash(bytes) }];
  return { source, bytes };
}
export async function verifyDownload(host, report, artifact, expected, caseId) {
  metadata(artifact);
  assert.deepEqual(await host.client.json('/api/v2/artifacts/' + artifact.id), artifact);
  const path = '/api/v2/artifacts/' + artifact.id + '/content';
  const response = await fetch(host.client.base + path, { signal: AbortSignal.timeout(5000) });
  const logId = response.headers.get('x-deviceforge-log-id');
  report.last_request = { case_id: caseId, path, method: 'GET', status: response.status, log_id: logId };
  report.requests.push({ ...report.last_request, phase: 'download', outcome: 'returned' });
  assert.equal(response.status, 200); assert.match(logId, uuid); host.client.logIds.add(logId);
  const reader = response.body.getReader(), chunks = []; let count = 0, complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) { complete = true; break; }
      count += item.value.byteLength; assert.ok(count <= expected.length, 'AD-DOWNLOAD-LIMIT:' + caseId);
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, count);
  assert.deepEqual(bytes, expected, 'AD-DOWNLOAD-BYTES:' + caseId);
  assert.equal(bytes.length, artifact.size); assert.equal(hash(bytes), artifact.sha256);
  return { artifact_id: artifact.id, log_id: logId, size: count, sha256: hash(bytes), original_bytes_equal: true };
}
export function installArgv(fixture, argv, deviceId = localId) {
  assert.equal(argv.length, 4); assert.deepEqual(argv.slice(0, 3), ['-s', deviceId, 'install']);
  assert.ok(isAbsolute(argv[3])); assert.equal(basename(argv[3]), 'input.apk');
  assert.ok(toNamespacedPath(resolve(dirname(argv[3]))).startsWith(toNamespacedPath(resolve(fixture.scratchRoot)) + sep));
}
export async function installationCopy(fixture, item, bytes, { live = false, deviceId = localId } = {}) {
  installArgv(fixture, item.ready.argv, deviceId);
  const retained = await readFile(item.directory + sep + 'install-input.bin');
  assert.deepEqual(retained, bytes, 'AD-INSTALL-COPY');
  if (live) assert.deepEqual(await readFile(item.ready.argv[3]), bytes);
  else await assert.rejects(lstat(dirname(item.ready.argv[3])), { code: 'ENOENT' });
  item.private_copy = { size: retained.length, sha256: hash(retained), original_bytes_equal: true, deleted_after: !live };
}
export const screenshotArgv = ['-s', localId, 'exec-out', 'screencap', '-p'];
async function oneArtifact(host, fixture, report, options) {
  const { kind, transport, entryPoint, source, bytes } = options;
  const caseId = kind + '-' + entryPoint + '-' + transport, before = await keys(fixture), baseline = await jobList(host);
  const business = kind === 'app.install' ? { artifact_id: source.id } : {};
  const entry = entryPoint === 'capability'
    ? await submitAction(host, report, caseId, action(report.provider, kind, localId, business), transport)
    : await submit(host, report, caseId, entryPoint === 'alias' ? alias(kind) : operation(kind),
      entryPoint === 'alias' ? { device_id: localId, ...business } : envelope(localId, business), transport);
  const job = await record(host, entry);
  assert.equal(job.error, null, 'AD-ARTIFACT-JOB:' + caseId);
  const baselineIds = new Set(baseline.map((item) => item.id));
  assert.deepEqual((await jobList(host)).filter((item) => !baselineIds.has(item.id)).map((item) => item.id), [entry.job_id]);
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  assert.equal(added.length, 1, 'AD-TOOL-COUNT:' + caseId);
  entry.tool = await finishedTool(added[0]);
  if (kind === 'app.install') {
    await installationCopy(fixture, entry.tool, bytes);
    const value = { artifact_id: source.id, output: 'Installed ' + source.filename + '\nSuccess' };
    assert.deepEqual(job.result, entryPoint === 'alias' ? value : { result: value, artifacts: [] });
  } else {
    assert.deepEqual(entry.tool.ready.argv, screenshotArgv);
    const artifact = entryPoint === 'alias' ? job.result : job.result.artifacts[0];
    if (entryPoint !== 'alias') {
      assert.equal(job.result.result, null); assert.equal(job.result.artifacts.length, 1);
    }
    metadata(artifact); assert.equal(artifact.filename, 'screenshot.png');
    entry.host_artifact = artifact;
    entry.download = await verifyDownload(host, report, artifact, fixture.pixelBytes, caseId);
  }
  await emptyScratch(fixture);
  report.checks.push({ name: caseId + ' 一Job/一工具、公开结果与真实文件字节', job_id: entry.job_id, passed: true });
  return entry;
}

async function artifactLocks(host, fixture, report, source, bytes) {
  const before = await keys(fixture);
  await setMode(fixture, 'hold');
  const first = await submitAction(host, report, '安装锁首任务', action(report.provider, 'app.install', localId, { artifact_id: source.id }), 'http');
  const held = await started(fixture, before, (argv) => installArgv(fixture, argv));
  await installationCopy(fixture, held, bytes, { live: true });
  await setMode(fixture, 'normal');
  const screenshot = await submit(host, report, '安装锁阻塞截图alias', alias('screenshot'), { device_id: localId }, 'mcp');
  const input = await submitAction(host, report, '安装锁阻塞旧input', action(report.provider, 'input', localId,
    { action: { kind: 'tap', x: 81, y: 82 } }), 'http');
  await delay(100);
  assert.deepEqual(await keys(fixture), [...before, held.directory].sort(), 'AD-ARTIFACT-LOCK-BLOCKED');
  await release(held);
  for (const entry of [first, screenshot, input]) await record(host, entry);
  first.tool = await finishedTool(held); await installationCopy(fixture, first.tool, bytes);
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory) && item.directory !== held.directory);
  assert.equal(added.length, 2);
  for (const [entry, argv] of [
    [screenshot, screenshotArgv], [input, ['-s', localId, 'shell', '-T', 'input', 'tap', '81', '82']],
  ]) {
    const item = added.find((candidate) => JSON.stringify(candidate.ready.argv) === JSON.stringify(argv));
    assert.ok(item); entry.tool = await finishedTool(item);
    assert.ok(BigInt(entry.tool.ready.unix_ns) >= BigInt(first.tool.completed.unix_ns));
  }
  const screenshotTool = screenshot.tool, inputTool = input.tool;
  assert.ok(BigInt(screenshotTool.completed.unix_ns) <= BigInt(inputTool.ready.unix_ns)
    || BigInt(inputTool.completed.unix_ns) <= BigInt(screenshotTool.ready.unix_ns), 'AD-ARTIFACT-LOCK-SERIAL');
  const value = { artifact_id: source.id, output: 'Installed ' + source.filename + '\nSuccess' };
  assert.deepEqual(first.history.result, { result: value, artifacts: [] });
  metadata(screenshot.history.result); screenshot.host_artifact = screenshot.history.result;
  screenshot.download = await verifyDownload(host, report, screenshot.host_artifact, fixture.pixelBytes, screenshot.case_id);
  assert.deepEqual(input.history.result, { result: { device_id: localId, action: 'tap', dispatched: true }, artifacts: [] });
  await emptyScratch(fixture);
  report.checks.push({ name: '安装能力、截图旧alias和原input共享同provider/同device写锁', passed: true,
    jobs: [first, screenshot, input].map((entry) => entry.job_id) });
}

async function cancellation(host, fixture, report, source, bytes) {
  for (const kind of ['app.install', 'screenshot']) {
    const before = await keys(fixture); await setMode(fixture, 'hold');
    const entry = await submitAction(host, report, '取消-' + kind, action(report.provider, kind, localId,
      kind === 'app.install' ? { artifact_id: source.id } : {}), 'mcp');
    const tool = await started(fixture, before, kind === 'app.install' ? (argv) => installArgv(fixture, argv) : screenshotArgv);
    if (kind === 'app.install') await installationCopy(fixture, tool, bytes, { live: true });
    await host.client.scope({ case_id: entry.case_id, phase: 'cancel' })
      .post('/api/v2/jobs/' + entry.job_id + '/cancel');
    const job = await record(host, entry, 'cancelled');
    assert.equal(job.result, null); assert.equal(await readFile(tool.directory + sep + 'ready.json', 'utf8').then(JSON.parse).then((value) => value.pid), tool.ready.pid);
    entry.tool = await finishedTool(tool, { cancelled: true });
    await assert.rejects(lstat(tool.directory + sep + 'release'), { code: 'ENOENT' });
    if (kind === 'app.install') await installationCopy(fixture, entry.tool, bytes);
    await emptyScratch(fixture);
    await setMode(fixture, 'normal');
    report.checks.push({ name: kind + ' 运行中取消、真实工具及父插件消失、失败无产物、scratch无残留', job_id: entry.job_id, passed: true });
  }
}

export async function artifactBusiness(host, fixture, report) {
  const { source, bytes } = await upload(host, report);
  report.install_source = source;
  fixture.installSource = source; fixture.installBytes = bytes;
  for (const kind of ['app.install', 'screenshot']) {
    for (const transport of ['http', 'mcp']) {
      await oneArtifact(host, fixture, report, { kind, transport, entryPoint: 'capability', source, bytes });
      await oneArtifact(host, fixture, report, { kind, transport, entryPoint: 'alias', source, bytes });
    }
  }
  await artifactLocks(host, fixture, report, source, bytes);
  await cancellation(host, fixture, report, source, bytes);
  report.checks.push({ name: '原九能力业务全部经过当前真实插件，APK安装与截图HTTP/MCP/旧alias完整链路', passed: true });
}

export async function preserveArtifacts(host, fixture, report, phase) {
  if (fixture.installSource) await verifyDownload(host, report, fixture.installSource, fixture.installBytes, phase + '-安装源');
  if (fixture.apksSource) await verifyDownload(host, report, fixture.apksSource, fixture.apksBytes, phase + '-APKS源');
  for (const entry of report.jobs.filter((item) => item.host_artifact)) {
    const downloaded = await verifyDownload(host, report, entry.host_artifact, fixture.pixelBytes, phase + '-' + entry.case_id);
    assert.equal(downloaded.sha256, entry.download.sha256);
  }
  await emptyScratch(fixture);
  report.artifact_history_phases ??= [];
  report.artifact_history_phases.push({ phase, source_retained: Boolean(fixture.installSource), apks_source_retained: Boolean(fixture.apksSource),
    screenshots: report.jobs.filter((item) => item.host_artifact).length, scratch_empty: true });
}
