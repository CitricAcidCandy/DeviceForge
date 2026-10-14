import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { action, envelope, submitAction } from './actions.mjs';
import { emptyScratch, metadata } from './artifacts.mjs';
import { apksArgv, apksCopy, apksHash, apksSample } from './apks-fixtures.mjs';
import { apksLocks } from './apks-locks.mjs';
import { alias, operation } from './deployment.mjs';
import {
  configureApks,
  finishedTool,
  keys,
  localId,
  observations,
  offlineId,
  otherId,
  setMode,
  started,
} from './fixtures.mjs';
import { jobList, record, submit } from './jobs.mjs';

export const apksResult = (fixture, deviceId) => ({
  artifact_id: fixture.apksSource.id,
  device_id: deviceId,
  installed: true,
});

export async function submitApks(
  host,
  fixture,
  report,
  caseId,
  { entryPoint = 'capability', transport = 'http', deviceId = localId } = {},
) {
  const input = { artifact_id: fixture.apksSource.id };
  return entryPoint === 'capability'
    ? submitAction(
        host,
        report,
        caseId,
        action(report.provider, 'app.install_apks', deviceId, input),
        transport,
      )
    : submit(
        host,
        report,
        caseId,
        entryPoint === 'alias' ? alias('app.install_apks') : operation('app.install_apks'),
        entryPoint === 'alias' ? { ...input, device_id: deviceId } : envelope(deviceId, input),
        transport,
      );
}

async function upload(host, fixture, report) {
  const bytes = apksSample();
  report.active_case_id = '上传安卓APKS源';
  const source = await host.client
    .scope({ case_id: report.active_case_id, phase: 'upload' })
    .json('/api/v2/artifacts?filename=' + encodeURIComponent('独立分包测试.apks'), {
      method: 'POST',
      status: 201,
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
  metadata(source);
  assert.equal(source.filename, '独立分包测试.apks');
  assert.equal(source.size, bytes.length);
  assert.equal(source.sha256, apksHash(bytes));
  fixture.apksSource = source;
  fixture.apksBytes = bytes;
  report.apks_source = source;
  report.artifact_sources.push({ metadata: source, bytes: bytes.length, sha256: apksHash(bytes) });
}

async function qualifications(host, fixture, report) {
  for (const options of [
    {
      java: false,
      jar: false,
      caseId: 'APKS-缺JAR-http',
      message: '部署者未配置bundletool JAR',
      entryPoint: 'capability',
      transport: 'http',
      deviceId: localId,
    },
    {
      java: false,
      jar: true,
      caseId: 'APKS-缺Java-alias-mcp',
      message: '部署者未配置Java入口',
      entryPoint: 'alias',
      transport: 'mcp',
      deviceId: otherId,
    },
  ]) {
    await configureApks(fixture, report, options);
    const before = await keys(fixture),
      baseline = await jobList(host);
    const entry = await submitApks(host, fixture, report, options.caseId, options);
    const job = await record(host, entry, 'failed');
    assert.equal(job.result, null);
    assert.equal(job.error, '依赖执行失败：工具依赖失败：' + options.message);
    assert.deepEqual(await keys(fixture), before, 'AD-APKS-MISSING-TOOLS');
    const ids = new Set(baseline.map((item) => item.id));
    assert.deepEqual(
      (await jobList(host)).filter((item) => !ids.has(item.id)).map((item) => item.id),
      [entry.job_id],
    );
    entry.configuration_rejected_before_java = true;
    await emptyScratch(fixture);
    report.checks.push({
      name: options.caseId + ' 一Job/零Java、精确依赖错误与scratch清理',
      job_id: entry.job_id,
      passed: true,
    });
  }
  await configureApks(fixture, report);
}

async function admission(host, fixture, report) {
  const base = action(report.provider, 'app.install_apks', localId, {
    artifact_id: fixture.apksSource.id,
  });
  const before = await keys(fixture),
    baseline = await jobList(host);
  const cases = [
    ['能力版本', { ...base, version: 2 }, 404, 'not_found'],
    ['离线设备', { ...base, device_id: offlineId }, 409, 'conflict'],
    ['旧代', { ...base, generation: '00000000-0000-4000-8000-000000000000' }, 409, 'conflict'],
    ['非法封套', { ...base, unexpected: true }, 400, 'invalid_input'],
  ];
  for (const [name, input, status, code] of cases) {
    report.active_case_id = 'APKS-准入-' + name;
    const observed = host.client.scope({ case_id: report.active_case_id, phase: 'reject' });
    await observed.post('/api/v2/device-actions', input, { status, code });
    await observed.tool('deviceforge.invoke_device', input, code);
  }
  // 旧alias保留ASCII设备ID；公开新能力另外验证中文serial原文。
  const input = { artifact_id: fixture.apksSource.id, device_id: localId };
  report.active_case_id = 'APKS-旧alias拒绝中文serial';
  const observed = host.client.scope({ case_id: report.active_case_id, phase: 'reject' });
  await observed.post(
    '/api/v2/jobs',
    { operation: alias('app.install_apks'), input },
    { status: 400, code: 'invalid_input' },
  );
  await observed.tool(alias('app.install_apks'), input, 'invalid_input');
  assert.deepEqual(await keys(fixture), before);
  assert.deepEqual(await jobList(host), baseline);
  report.checks.push({
    name: 'APKS精确版本/离线/旧代/封套及旧ASCII alias拒绝，零Job/零工具',
    passed: true,
    cases: cases.map(([name, , status, code]) => ({ name, status, code })),
  });
}

async function one(host, fixture, report, options) {
  const { entryPoint, transport, mode = 'normal' } = options;
  const deviceId = entryPoint === 'alias' ? otherId : localId;
  const caseId = 'APKS-' + entryPoint + '-' + transport + '-' + mode;
  await setMode(fixture, mode);
  const before = await keys(fixture),
    baseline = await jobList(host);
  const entry = await submitApks(host, fixture, report, caseId, {
    entryPoint,
    transport,
    deviceId,
  });
  const job = await record(host, entry);
  assert.equal(job.error, null);
  const ids = new Set(baseline.map((item) => item.id));
  assert.deepEqual(
    (await jobList(host)).filter((item) => !ids.has(item.id)).map((item) => item.id),
    [entry.job_id],
  );
  const tools = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  assert.equal(tools.length, 1, 'AD-APKS-ONE-JAVA');
  entry.tool = await finishedTool(tools[0]);
  await apksCopy(fixture, entry.tool, fixture.apksBytes, { deviceId });
  const value = apksResult(fixture, deviceId);
  assert.deepEqual(job.result, entryPoint === 'alias' ? value : { result: value, artifacts: [] });
  await emptyScratch(fixture);
  await setMode(fixture, 'normal');
  report.checks.push({
    name: caseId + ' 一Job/一Java、唯一授权APKS/SHA、固定argv及私有目录',
    passed: true,
    job_id: entry.job_id,
  });
}

async function cancellation(host, fixture, report) {
  const before = await keys(fixture);
  await setMode(fixture, 'hold');
  const entry = await submitApks(host, fixture, report, 'APKS-在途取消-mcp', { transport: 'mcp' });
  const tool = await started(fixture, before, (argv) => apksArgv(fixture, argv));
  await apksCopy(fixture, tool, fixture.apksBytes, { live: true });
  await host.client
    .scope({ case_id: entry.case_id, phase: 'cancel' })
    .post('/api/v2/jobs/' + entry.job_id + '/cancel');
  const job = await record(host, entry, 'cancelled');
  assert.equal(job.result, null);
  entry.tool = await finishedTool(tool, { cancelled: true });
  await apksCopy(fixture, entry.tool, fixture.apksBytes);
  await assert.rejects(lstat(join(tool.directory, 'release')), { code: 'ENOENT' });
  await emptyScratch(fixture);
  await setMode(fixture, 'normal');
  report.checks.push({
    name: 'APKS在途取消、直接Java/父插件PID消失、私有副本删除与唯一取消终态',
    passed: true,
    job_id: entry.job_id,
  });
}

export async function apksBusiness(host, fixture, report) {
  await upload(host, fixture, report);
  await qualifications(host, fixture, report);
  await admission(host, fixture, report);
  for (const transport of ['http', 'mcp'])
    for (const entryPoint of ['capability', 'direct', 'alias']) {
      await one(host, fixture, report, { transport, entryPoint });
    }
  for (const mode of ['apks-empty', 'apks-lossy'])
    await one(host, fixture, report, { transport: 'http', entryPoint: 'capability', mode });
  await apksLocks(host, fixture, report);
  await cancellation(host, fixture, report);
}
