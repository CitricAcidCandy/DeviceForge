import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { action, envelope, submitAction } from './actions.mjs';
import { alias, operation } from './deployment.mjs';
import { bundle, detailArgv } from './applications.mjs';
import { finishedTool, keys, localId, observations, setMode, started } from './fixtures.mjs';
import { jobList, record, submit } from './jobs.mjs';

const full = {
  name: bundle,
  versionCode: 7,
  custom: { enabled: true, text: 'ordinary failed text' },
  metadata: [1, 'two', null],
  hapModuleInfos: [{ bundleName: 'other.app', mainElementName: 'Entry' }, null],
};
const titled = { name: bundle, versionCode: 8, custom: { title: true } };
const noEntry = { name: bundle, status: 'installed', custom: [true, 7] };

function detailInput(point, request) {
  return point === 'capability'
    ? action(request.provider, 'app.detail', request.device_id, { bundle: request.bundle })
    : point === 'alias'
      ? { device_id: request.device_id, bundle: request.bundle }
      : envelope(request.device_id, { bundle: request.bundle });
}

export async function detailEntry(
  host,
  fixture,
  report,
  { caseId, point, transport, mode, expected },
) {
  const before = await keys(fixture),
    baseline = await jobList(host);
  await setMode(fixture, mode);
  const request = { provider: report.provider, device_id: localId, bundle };
  const entry =
    point === 'capability'
      ? await submitAction(host, report, caseId, detailInput(point, request), transport)
      : await submit(
          host,
          report,
          caseId,
          point === 'alias' ? alias('app.detail') : operation('app.detail'),
          detailInput(point, request),
          transport,
        );
  const job = await record(host, entry),
    added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  const previous = new Set(baseline.map((item) => item.id));
  assert.deepEqual(
    (await jobList(host)).filter((item) => !previous.has(item.id)).map((item) => item.id),
    [entry.job_id],
    'HD-DETAIL-ONE-JOB:' + caseId,
  );
  assert.equal(added.length, 1, 'HD-DETAIL-ONE-TOOL:' + caseId);
  assert.deepEqual(added[0].ready.argv, detailArgv());
  entry.tool = await finishedTool(added[0]);
  assert.deepEqual(
    job.result,
    point === 'alias' ? expected : { result: expected, artifacts: [] },
    'HD-DETAIL-RESULT:' + caseId,
  );
  assert.equal(job.error, null);
  entry.detail_point = point;
  return entry;
}

export async function applicationDetails(host, fixture, report) {
  const cases = [
    ['capability', 'http', 'detail-full', full],
    ['capability', 'mcp', 'detail-no-entry', noEntry],
    ['direct', 'http', 'detail-full', full],
    ['direct', 'mcp', 'detail-title', titled],
    ['alias', 'http', 'detail-no-entry', noEntry],
    ['alias', 'mcp', 'detail-title', titled],
  ];
  const entries = [];
  for (const [point, transport, mode, expected] of cases)
    entries.push(
      await detailEntry(host, fixture, report, {
        caseId: `详情-${point}-${transport}`,
        point,
        transport,
        mode,
        expected,
      }),
    );
  report.application_detail_matrix = entries.map((entry) => ({
    case_id: entry.case_id,
    point: entry.detail_point,
    operation: entry.operation,
    transport: entry.transport,
    job_id: entry.job_id,
    expected_tool_calls: 1,
  }));
  report.checks.push({
    name: 'app.detail完整对象/未知字段/无启动字段，三入口双协议固定HDC与旧绑定',
    passed: true,
    jobs: entries.map((entry) => entry.job_id),
    tools: entries.length,
  });
  await setMode(fixture, 'normal');
}

export async function applicationDetailInputErrors(host, fixture, report) {
  const before = await jobList(host),
    previous = await keys(fixture),
    cases = [
      {},
      { bundle: null },
      { bundle: 7 },
      { bundle: '' },
      { bundle: '--bad' },
      { bundle: 'com.smoke;echo' },
      { bundle, unexpected: true },
    ];
  for (let index = 0; index < cases.length; index++)
    for (const point of ['capability', 'direct', 'alias']) {
      const input = cases[index],
        caseId = `详情输入-${point}-${index}`;
      const client = host.client.scope({ case_id: caseId, phase: 'reject' });
      const value =
        point === 'capability'
          ? action(report.provider, 'app.detail', localId, input)
          : point === 'alias'
            ? { device_id: localId, ...input }
            : envelope(localId, input);
      if (point === 'capability') {
        await client.post('/api/v2/device-actions', value, { status: 400, code: 'invalid_input' });
        await client.tool('deviceforge.invoke_device', value, 'invalid_input');
      } else {
        await client.post(
          '/api/v2/jobs',
          {
            operation: point === 'alias' ? alias('app.detail') : operation('app.detail'),
            input: value,
          },
          { status: 400, code: 'invalid_input' },
        );
        await client.tool(
          point === 'alias' ? alias('app.detail') : operation('app.detail'),
          value,
          'invalid_input',
        );
      }
    }
  assert.deepEqual(await jobList(host), before);
  assert.deepEqual(await keys(fixture), previous);
  report.application_detail_input_errors = {
    samples: cases.length,
    entries: 3,
    protocols: 2,
    requests: cases.length * 3 * 2,
  };
  report.checks.push({
    name: 'app.detail严格业务输入HTTP/MCP拒绝且零Job零HDC',
    passed: true,
    requests: cases.length * 3 * 2,
  });
}

export async function applicationDetailFailures(host, fixture, report) {
  const cases = [
    [
      'detail-wrong-title',
      'capability',
      'http',
      '依赖执行失败：工具依赖失败：应用详情JSON无效或超出限额',
    ],
    ['detail-array', 'capability', 'mcp', '依赖执行失败：工具依赖失败：应用详情JSON根节点无效'],
    [
      'detail-duplicate',
      'direct',
      'http',
      '依赖执行失败：工具依赖失败：应用详情JSON无效或超出限额',
    ],
    ['detail-tail', 'direct', 'mcp', '依赖执行失败：工具依赖失败：应用详情JSON无效或超出限额'],
    ['detail-depth', 'alias', 'http', '依赖执行失败：工具依赖失败：应用详情JSON无效或超出限额'],
    ['detail-nodes', 'alias', 'mcp', '依赖执行失败：工具依赖失败：应用详情JSON无效或超出限额'],
    [
      'detail-stdout-utf8',
      'capability',
      'http',
      '依赖执行失败：工具依赖失败：应用详情输出不是有效UTF-8',
    ],
    ['detail-stderr-utf8', 'direct', 'mcp', '依赖执行失败：工具依赖失败：HDC输出不是有效UTF-8'],
    ['detail-stderr-fail', 'alias', 'http', '依赖执行失败：工具依赖失败：HDC返回失败诊断'],
  ];
  const jobs = [];
  for (const [mode, point, transport, error] of cases) {
    const before = await keys(fixture);
    await setMode(fixture, mode);
    const request = { provider: report.provider, device_id: localId, bundle };
    const entry =
      point === 'capability'
        ? await submitAction(
            host,
            report,
            `详情失败-${mode}`,
            detailInput(point, request),
            transport,
          )
        : await submit(
            host,
            report,
            `详情失败-${mode}`,
            point === 'alias' ? alias('app.detail') : operation('app.detail'),
            detailInput(point, request),
            transport,
          );
    const job = await record(host, entry, 'failed');
    assert.equal(job.result, null);
    assert.equal(job.error, error);
    const added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
    assert.equal(added.length, 1);
    assert.deepEqual(added[0].ready.argv, detailArgv());
    entry.tool = await finishedTool(added[0]);
    jobs.push(entry.job_id);
  }
  await setMode(fixture, 'normal');
  report.application_detail_failure_jobs = jobs;
  report.checks.push({
    name: 'app.detail错误标题/根/重复/尾随/深度/节点/UTF8/诊断精确失败',
    passed: true,
    jobs,
  });
}

export async function applicationDetailResources(host, fixture, report) {
  const before = await keys(fixture);
  await setMode(fixture, 'detail-hold');
  const held = await submitAction(
    host,
    report,
    '详情读取门闩取消',
    action(report.provider, 'app.detail', localId, { bundle }),
    'http',
  );
  const heldTool = await started(fixture, before, detailArgv());
  await setMode(fixture, 'normal');
  const readBefore = await keys(fixture);
  const parallel = await submit(
    host,
    report,
    '详情同设备并行读取',
    operation('app.detail'),
    envelope(localId, { bundle }),
    'mcp',
  );
  const parallelTool = await started(fixture, readBefore, detailArgv());
  const parallelJob = await record(host, parallel);
  parallel.tool = await finishedTool(parallelTool);
  assert.deepEqual(parallelJob.result, {
    result: {
      name: bundle,
      hapModuleInfos: [
        { bundleName: bundle, mainAbility: 'com.smoke.harmony.MainAbility' },
        { mainAbility: 'OtherAbility' },
      ],
    },
    artifacts: [],
  });
  assert.equal(parallelJob.error, null);
  assert.equal((await host.client.job(held.job_id)).status, 'running');
  const during = await observations(fixture);
  assert.equal(during.filter((item) => !before.includes(item.directory)).length, 2);
  await host.client
    .scope({ case_id: held.case_id, phase: 'cancel' })
    .post('/api/v2/jobs/' + held.job_id + '/cancel');
  await record(host, held, 'cancelled');
  assert.equal(held.history.result, null);
  held.tool = await finishedTool(heldTool, { cancelled: true });
  await assert.rejects(lstat(join(heldTool.directory, 'release')), { code: 'ENOENT' });
  assert.deepEqual(
    await keys(fixture),
    [...before, heldTool.directory, parallelTool.directory].sort(),
  );
  report.application_detail_resource_jobs = [held.job_id, parallel.job_id];
  report.checks.push({
    name: '详情同设备读并行、held取消唯一终态与无后续HDC',
    passed: true,
    jobs: report.application_detail_resource_jobs,
  });
}

export async function reloadedDetail(host, fixture, report) {
  const entry = await detailEntry(host, fixture, report, {
    caseId: '新代应用详情-alias-mcp',
    point: 'alias',
    transport: 'mcp',
    mode: 'detail-full',
    expected: full,
  });
  report.reloaded_detail_job = entry.job_id;
  await setMode(fixture, 'normal');
  report.checks.push({
    name: '新代重新发现后详情完整对象可读，旧代引用另行拒绝',
    passed: true,
    job_id: entry.job_id,
  });
}
