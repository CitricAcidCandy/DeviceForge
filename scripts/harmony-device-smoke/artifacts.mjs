import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { action, envelope, submitAction } from './actions.mjs';
import { alias, operation } from './deployment.mjs';
import { finishedTool, keys, localId, observations, otherId, release, setMode, started } from './fixtures.mjs';
import { jobList, record, submit, uuid } from './jobs.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function emptyScratch(fixture) { assert.deepEqual(await readdir(fixture.scratchRoot), [], 'HD-SCRATCH-EMPTY'); }
export function installArgv(fixture, argv) {
  assert.equal(argv.length, 4); assert.deepEqual(argv.slice(0, 3), ['-t', localId, 'install']);
  assert.ok(isAbsolute(argv[3])); assert.equal(basename(argv[3]), 'input.hap');
  assert.ok(resolve(dirname(argv[3])).startsWith(resolve(fixture.scratchRoot) + sep));
}
export async function installationCopy(fixture, item, { live = false } = {}) {
  installArgv(fixture, item.ready.argv); const bytes = await readFile(join(item.directory, 'install-input.bin'));
  assert.deepEqual(bytes, fixture.installBytes, 'HD-INSTALL-COPY');
  if (live) assert.deepEqual(await readFile(item.ready.argv[3]), fixture.installBytes);
  else await assert.rejects(lstat(dirname(item.ready.argv[3])), { code: 'ENOENT' });
  item.private_copy = { size: bytes.length, sha256: hash(bytes), original_bytes_equal: true, deleted_after: !live };
}
export async function upload(host, fixture, report) {
  report.active_case_id = '上传Harmony安装源';
  // 上传端要求有效 ZIP 外壳；这个合成归档只验证 HAP 副本链路，不代表真实可安装应用。
  const bytes = Buffer.from('UEsDBBQAAAAIAHaYSF3XonWNIQAAABgAAAATAAAAQW5kcm9pZE1hbmlmZXN0LnhtbHJJLctMTnXLL0pPVXixf8KLhT0vV/W8WN8IAAAA//8DAFBLAQIUABQAAAAIAHaYSF3XonWNIQAAABgAAAATAAAAAAAAAAAAAAAAAAAAAABBbmRyb2lkTWFuaWZlc3QueG1sUEsFBgAAAAABAAEAQQAAAFIAAAAAAA==', 'base64');
  const source = await host.client.scope({ case_id: '上传Harmony安装源', phase: 'upload' }).json('/api/v2/artifacts?filename=' + encodeURIComponent('独立测试.hap'),
    { method: 'POST', status: 201, headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  assert.match(source.id, uuid); assert.equal(source.filename, '独立测试.hap');
  assert.equal(source.size, bytes.length); assert.equal(source.sha256, hash(bytes));
  fixture.installSource = source; fixture.installBytes = bytes; report.install_source = source;
}
export async function preserveSource(host, fixture, report, phase) {
  const source = fixture.installSource; assert.deepEqual(await host.client.json('/api/v2/artifacts/' + source.id), source);
  const path = '/api/v2/artifacts/' + source.id + '/content';
  const response = await fetch(host.client.base + path, { signal: AbortSignal.timeout(5000) });
  const logId = response.headers.get('x-deviceforge-log-id'); assert.equal(response.status, 200); assert.match(logId, uuid);
  report.requests.push({ case_id: phase, phase: 'download', path, method: 'GET', status: response.status, log_id: logId, outcome: 'returned' });
  host.client.logIds.add(logId); const reader = response.body.getReader(), chunks = []; let size = 0, completed = false;
  try { while (true) { const item = await reader.read(); if (item.done) { completed = true; break; }
    size += item.value.byteLength; assert.ok(size <= fixture.installBytes.length, 'HD-DOWNLOAD-LIMIT'); chunks.push(Buffer.from(item.value)); } }
  finally { if (!completed) await reader.cancel().catch(() => {}); reader.releaseLock(); }
  assert.deepEqual(Buffer.concat(chunks, size), fixture.installBytes, 'HD-DOWNLOAD-BYTES');
  report.artifact_history_phases ??= []; report.artifact_history_phases.push({ phase, artifact_id: source.id, original_bytes_equal: true, log_id: logId });
  await emptyScratch(fixture);
}
const installResult = (fixture) => ({ artifact_id: fixture.installSource.id,
  output: 'Installed ' + fixture.installSource.filename + '\nmsg:install bundle successfully.' });
export async function installBusiness(host, fixture, report) {
  for (const transport of ['http', 'mcp']) for (const point of ['capability', 'alias']) {
    const before = await keys(fixture), baseline = await jobList(host), caseId = 'app.install-' + point + '-' + transport;
    const input = { artifact_id: fixture.installSource.id };
    const entry = point === 'capability'
      ? await submitAction(host, report, caseId, action(report.provider, 'app.install', localId, input), transport)
      : await submit(host, report, caseId, alias('app.install'), { device_id: localId, ...input }, transport);
    const job = await record(host, entry), ids = new Set(baseline.map((item) => item.id));
    assert.deepEqual((await jobList(host)).filter((item) => !ids.has(item.id)).map((item) => item.id), [entry.job_id]);
    const added = (await observations(fixture)).filter((item) => !before.includes(item.directory)); assert.equal(added.length, 1);
    entry.tool = await finishedTool(added[0]); await installationCopy(fixture, entry.tool);
    assert.deepEqual(job.result, point === 'alias' ? installResult(fixture) : { result: installResult(fixture), artifacts: [] });
    assert.equal(job.error, null); assert.ok(!JSON.stringify(job.result).includes(entry.tool.ready.argv[3])); await emptyScratch(fixture);
    report.checks.push({ name: caseId + ' 一Job/一工具、HAP私有副本原字节及清理', passed: true, job_id: entry.job_id });
  }
}
export async function sharedLocks(host, fixture, report) {
  const before = await keys(fixture); await setMode(fixture, 'hold');
  const first = await submitAction(host, report, '安装同设备写锁首任务', action(report.provider, 'app.install', localId, { artifact_id: fixture.installSource.id }));
  const held = await started(fixture, before, (argv) => installArgv(fixture, argv)); await installationCopy(fixture, held, { live: true });
  await setMode(fixture, 'normal');
  const queued = await submit(host, report, '同设备卸载alias等待', alias('app.uninstall'), { device_id: localId, package: 'com.smoke.queued' }, 'mcp');
  const direct = await submit(host, report, '同设备卸载direct等待', operation('app.uninstall'), envelope(localId, { package: 'com.smoke.direct' }), 'http');
  const parallel = await submitAction(host, report, '不同设备卸载并行', action(report.provider, 'app.uninstall', otherId, { package: 'com.smoke.parallel' }), 'mcp');
  await record(host, parallel); const during = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  assert.equal(during.length, 2, 'HD-LOCK-BLOCKED'); const parallelTool = during.find((item) => item.directory !== held.directory);
  assert.deepEqual(parallelTool.ready.argv, ['-t', otherId, 'uninstall', 'com.smoke.parallel']); parallel.tool = await finishedTool(parallelTool);
  assert.equal((await host.client.job(first.job_id)).status, 'running'); await delay(100);
  assert.deepEqual(await keys(fixture), [...before, held.directory, parallelTool.directory].sort(), 'HD-LOCK-NO-QUEUED-START');
  await release(held); for (const entry of [first, queued, direct]) await record(host, entry);
  first.tool = await finishedTool(held); await installationCopy(fixture, first.tool);
  assert.deepEqual(first.history.result, { result: installResult(fixture), artifacts: [] });
  assert.deepEqual(parallel.history.result, { result: { output: 'msg:uninstall bundle successfully.' }, artifacts: [] });
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory) && ![held.directory, parallelTool.directory].includes(item.directory));
  assert.equal(added.length, 2); const ordered = [];
  for (const [entry, name] of [[queued, 'com.smoke.queued'], [direct, 'com.smoke.direct']]) {
    const item = added.find((candidate) => candidate.ready.argv[3] === name); assert.ok(item); assert.deepEqual(item.ready.argv, ['-t', localId, 'uninstall', name]);
    entry.tool = await finishedTool(item); ordered.push(entry.tool); assert.ok(BigInt(entry.tool.ready.unix_ns) >= BigInt(first.tool.completed.unix_ns));
    assert.deepEqual(entry.history.result, entry === queued ? { output: 'msg:uninstall bundle successfully.' } : { result: { output: 'msg:uninstall bundle successfully.' }, artifacts: [] });
  }
  assert.ok(BigInt(parallel.tool.ready.unix_ns) < BigInt(first.tool.completed.unix_ns));
  assert.ok(BigInt(ordered[0].completed.unix_ns) <= BigInt(ordered[1].ready.unix_ns) || BigInt(ordered[1].completed.unix_ns) <= BigInt(ordered[0].ready.unix_ns));
  await emptyScratch(fixture); report.checks.push({ name: '能力/direct jobs/旧alias共享同设备写锁、不同设备并行', passed: true,
    jobs: [first, queued, direct, parallel].map((item) => item.job_id), boundary: '仅当前四核心设备业务，不证明daemon或性能' });
}
export async function cancellation(host, fixture, report) {
  const before = await keys(fixture); await setMode(fixture, 'hold');
  const entry = await submitAction(host, report, '在途取消HAP安装', action(report.provider, 'app.install', localId, { artifact_id: fixture.installSource.id }), 'mcp');
  const tool = await started(fixture, before, (argv) => installArgv(fixture, argv)); await installationCopy(fixture, tool, { live: true });
  await host.client.scope({ case_id: entry.case_id, phase: 'cancel' }).post('/api/v2/jobs/' + entry.job_id + '/cancel');
  await record(host, entry, 'cancelled'); assert.equal(entry.history.result, null);
  entry.tool = await finishedTool(tool, { cancelled: true }); await installationCopy(fixture, entry.tool);
  await assert.rejects(lstat(join(tool.directory, 'release')), { code: 'ENOENT' }); await emptyScratch(fixture); await setMode(fixture, 'normal');
  report.checks.push({ name: '安装在途取消、直接工具/父插件PID消失、私有副本删除、同Job唯一取消终态', passed: true, job_id: entry.job_id });
}
