import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { action, envelope, submitAction } from './actions.mjs';
import {
  emptyScratch,
  installArgv,
  installationCopy,
  metadata,
  verifyDownload,
} from './artifacts.mjs';
import { apksArgv, apksCopy } from './apks-fixtures.mjs';
import { alias, operation } from './deployment.mjs';
import {
  finishedTool,
  keys,
  localId,
  observations,
  otherId,
  release,
  setMode,
  started,
} from './fixtures.mjs';
import { oneJob, record, submit } from './jobs.mjs';

const screenshotArgv = ['-s', otherId, 'exec-out', 'screencap', '-p'];
const value = (fixture) => ({
  artifact_id: fixture.apksSource.id,
  device_id: otherId,
  installed: true,
});
const apkValue = (fixture) => ({
  artifact_id: fixture.installSource.id,
  output: 'Installed ' + fixture.installSource.filename + '\nSuccess',
});
const ordered = (first, second) =>
  assert.ok(BigInt(first.completed.unix_ns) <= BigInt(second.ready.unix_ns), 'AD-APKS-LOCK-ORDER');

async function screenshot(host, fixture, report, entry) {
  metadata(entry.history.result);
  entry.host_artifact = entry.history.result;
  entry.download = await verifyDownload(
    host,
    report,
    entry.host_artifact,
    fixture.pixelBytes,
    entry.case_id,
  );
}

async function apksFirst(host, fixture, report) {
  const before = await keys(fixture);
  await setMode(fixture, 'hold');
  const first = await submitAction(
    host,
    report,
    'APKS锁首任务',
    action(report.provider, 'app.install_apks', otherId, { artifact_id: fixture.apksSource.id }),
  );
  const held = await started(fixture, before, (argv) => apksArgv(fixture, argv, otherId));
  await apksCopy(fixture, held, fixture.apksBytes, { deviceId: otherId, live: true });
  await setMode(fixture, 'normal');
  const apk = await submit(
    host,
    report,
    'APKS锁阻塞APK-direct-mcp',
    operation('app.install'),
    envelope(otherId, { artifact_id: fixture.installSource.id }),
    'mcp',
  );
  const image = await submit(host, report, 'APKS锁阻塞截图-alias-http', alias('screenshot'), {
    device_id: otherId,
  });
  const queued = await submit(
    host,
    report,
    'APKS锁阻塞APKS-alias-mcp',
    alias('app.install_apks'),
    { device_id: otherId, artifact_id: fixture.apksSource.id },
    'mcp',
  );
  const parallel = await oneJob(host, fixture, report, {
    caseId: 'APKS锁另一设备并行',
    operation: operation('app.stop'),
    input: envelope(localId, { package: 'org.smoke.apks.parallel' }),
    transport: 'http',
    argv: ['-s', localId, 'shell', 'am', 'force-stop', 'org.smoke.apks.parallel'],
    expected: { result: { output: '' }, artifacts: [] },
  });
  assert.deepEqual(
    await keys(fixture),
    [...before, held.directory, parallel.tool.directory].sort(),
    'AD-APKS-LOCK-BLOCKED',
  );
  await release(held);
  for (const entry of [first, apk, image, queued]) await record(host, entry);
  first.tool = await finishedTool(held);
  await apksCopy(fixture, first.tool, fixture.apksBytes, { deviceId: otherId });
  assert.deepEqual(first.history.result, { result: value(fixture), artifacts: [] });
  const added = (await observations(fixture)).filter(
    (item) =>
      !before.includes(item.directory) &&
      item.directory !== held.directory &&
      item.directory !== parallel.tool.directory,
  );
  assert.equal(added.length, 3, 'AD-APKS-LOCK-THREE-WAITERS');
  for (const [entry, accepts] of [
    [apk, (argv) => argv.length === 4 && argv[2] === 'install'],
    [image, (argv) => JSON.stringify(argv) === JSON.stringify(screenshotArgv)],
    [queued, (argv) => argv[0] === '-Xmx256m'],
  ]) {
    const matches = added.filter((item) => accepts(item.ready.argv));
    assert.equal(matches.length, 1);
    entry.tool = await finishedTool(matches[0]);
    ordered(first.tool, entry.tool);
  }
  await installationCopy(fixture, apk.tool, fixture.installBytes, { deviceId: otherId });
  assert.deepEqual(apk.history.result, { result: apkValue(fixture), artifacts: [] });
  await screenshot(host, fixture, report, image);
  await apksCopy(fixture, queued.tool, fixture.apksBytes, { deviceId: otherId });
  assert.deepEqual(queued.history.result, value(fixture));
  const orderedTools = [apk.tool, image.tool, queued.tool].sort((left, right) =>
    BigInt(left.ready.unix_ns) < BigInt(right.ready.unix_ns) ? -1 : 1,
  );
  for (let index = 1; index < orderedTools.length; index++)
    ordered(orderedTools[index - 1], orderedTools[index]);
  assert.ok(
    BigInt(parallel.tool.completed.unix_ns) < BigInt(first.tool.completed.unix_ns),
    'AD-APKS-OTHER-DEVICE-PARALLEL',
  );
  await emptyScratch(fixture);
  report.checks.push({
    name: 'APKS能力/旧alias与APK直接贡献、截图alias同设备逐项串行，另一设备并行',
    passed: true,
    jobs: [first, apk, image, queued, parallel].map((entry) => entry.job_id),
    boundary: '实际门闩与工具时间，未证明共享ADB server或性能',
  });
}

async function existingFirst(host, fixture, report, kind) {
  const before = await keys(fixture);
  await setMode(fixture, 'hold');
  const input = kind === 'app.install' ? { artifact_id: fixture.installSource.id } : {};
  const first = await submit(
    host,
    report,
    'APKS反向锁-' + kind,
    alias(kind),
    { device_id: otherId, ...input },
    'mcp',
  );
  const held = await started(
    fixture,
    before,
    kind === 'app.install' ? (argv) => installArgv(fixture, argv, otherId) : screenshotArgv,
  );
  if (kind === 'app.install')
    await installationCopy(fixture, held, fixture.installBytes, { deviceId: otherId, live: true });
  await setMode(fixture, 'normal');
  const queued = await submitAction(
    host,
    report,
    'APKS等待-' + kind,
    action(report.provider, 'app.install_apks', otherId, { artifact_id: fixture.apksSource.id }),
  );
  await delay(100);
  assert.deepEqual(
    await keys(fixture),
    [...before, held.directory].sort(),
    'AD-APKS-REVERSE-LOCK-BLOCKED',
  );
  await release(held);
  await record(host, first);
  await record(host, queued);
  first.tool = await finishedTool(held);
  if (kind === 'app.install') {
    await installationCopy(fixture, first.tool, fixture.installBytes, { deviceId: otherId });
    assert.deepEqual(first.history.result, apkValue(fixture));
  } else await screenshot(host, fixture, report, first);
  const added = (await observations(fixture)).filter(
    (item) => !before.includes(item.directory) && item.directory !== held.directory,
  );
  assert.equal(added.length, 1);
  queued.tool = await finishedTool(added[0]);
  ordered(first.tool, queued.tool);
  await apksCopy(fixture, queued.tool, fixture.apksBytes, { deviceId: otherId });
  assert.deepEqual(queued.history.result, { result: value(fixture), artifacts: [] });
  await emptyScratch(fixture);
  report.checks.push({
    name: kind + '旧alias在途阻塞APKS公开能力，原共享写锁反向验证',
    passed: true,
    jobs: [first.job_id, queued.job_id],
  });
}

export async function apksLocks(host, fixture, report) {
  await apksFirst(host, fixture, report);
  for (const kind of ['app.install', 'screenshot'])
    await existingFirst(host, fixture, report, kind);
}
