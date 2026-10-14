import assert from 'node:assert/strict';
import { action, envelope, submitAction } from './actions.mjs';
import { alias, operation } from './deployment.mjs';
import { finishedTool, keys, localId, observations, setMode } from './fixtures.mjs';
import { jobList, record, submit } from './jobs.mjs';

export const appNames = ['app.start', 'app.stop', 'app.reset'];
export const bundle = 'com.smoke.harmony',
  ability = 'com.smoke.harmony.MainAbility';
export const outputFor = (name) =>
  name === 'app.start'
    ? 'start ability successfully'
    : name === 'app.stop'
      ? 'force stop process successfully.'
      : 'clean bundle data files successfully.';
export const inputFor = (name, automatic = false) =>
  name === 'app.start' && !automatic ? { bundle, ability } : { bundle };
export const argvFor = (name, deviceId = localId) =>
  name === 'app.start'
    ? ['-t', deviceId, 'shell', 'aa', 'start', '-a', ability, '-b', bundle]
    : name === 'app.stop'
      ? ['-t', deviceId, 'shell', 'aa', 'force-stop', bundle]
      : ['-t', deviceId, 'shell', 'bm', 'clean', '-d', '-n', bundle];
export const detailArgv = (deviceId = localId) => [
  '-t',
  deviceId,
  'shell',
  'bm',
  'dump',
  '-n',
  bundle,
];

export async function submitApplication(
  host,
  report,
  { caseId, name, point, transport, automatic = false, deviceId = localId },
) {
  const input = inputFor(name, automatic);
  return point === 'capability'
    ? submitAction(host, report, caseId, action(report.provider, name, deviceId, input), transport)
    : submit(
        host,
        report,
        caseId,
        point === 'alias' ? alias(name) : operation(name),
        point === 'alias' ? { device_id: deviceId, ...input } : envelope(deviceId, input),
        transport,
      );
}

export async function applicationCase(host, fixture, report, request) {
  const before = await keys(fixture),
    baseline = await jobList(host);
  const entry = await submitApplication(host, report, request),
    job = await record(host, entry);
  const ids = new Set(baseline.map((item) => item.id));
  assert.deepEqual(
    (await jobList(host)).filter((item) => !ids.has(item.id)).map((item) => item.id),
    [entry.job_id],
    'HD-APP-ONE-JOB',
  );
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  const expectedArgv = request.automatic
    ? [detailArgv(request.deviceId), argvFor(request.name, request.deviceId)]
    : [argvFor(request.name, request.deviceId)];
  assert.equal(added.length, expectedArgv.length, 'HD-APP-TOOL-COUNT');
  assert.deepEqual(
    added.map((item) => item.ready.argv),
    expectedArgv,
    'HD-APP-ARGV',
  );
  assert.equal(
    new Set(added.map((item) => item.ready.plugin_pid)).size,
    1,
    'HD-AUTO-SAME-PLUGIN-PID',
  );
  entry.tools = [];
  for (const item of added) entry.tools.push(await finishedTool(item));
  if (request.automatic)
    assert.ok(
      BigInt(entry.tools[0].completed.unix_ns) <= BigInt(entry.tools[1].ready.unix_ns),
      'HD-AUTO-QUERY-BEFORE-START',
    );
  const result = { output: outputFor(request.name) };
  assert.deepEqual(
    job.result,
    request.point === 'alias' ? result : { result, artifacts: [] },
    'HD-APP-RESULT',
  );
  assert.equal(job.error, null);
  const matrix = {
    case_id: request.caseId,
    name: request.name,
    point: request.point,
    transport: request.transport,
    automatic: request.automatic === true,
    expected_tool_calls: expectedArgv.length,
    actual_tool_calls: entry.tools.length,
    job_id: entry.job_id,
  };
  if (request.automatic)
    matrix.query_format =
      request.detailMode === 'prefixed-detail'
        ? '精确bundle标题+JSON，首模块选择'
        : '纯JSON，首模块选择';
  report.application_matrix ??= [];
  report.application_matrix.push(matrix);
  return entry;
}

export async function applications(host, fixture, report) {
  for (const name of appNames)
    for (const point of ['capability', 'direct', 'alias'])
      for (const transport of ['http', 'mcp']) {
        await applicationCase(host, fixture, report, {
          caseId: `${name}-${point}-${transport}`,
          name,
          point,
          transport,
        });
      }
  for (const point of ['capability', 'direct', 'alias'])
    for (const transport of ['http', 'mcp']) {
      const detailMode = point === 'alias' && transport === 'mcp' ? 'prefixed-detail' : 'normal';
      await setMode(fixture, detailMode);
      await applicationCase(host, fixture, report, {
        caseId: `app.start-auto-${point}-${transport}`,
        name: 'app.start',
        point,
        transport,
        automatic: true,
        detailMode,
      });
    }
  await setMode(fixture, 'normal');
  assert.equal(report.application_matrix.length, 24);
  assert.equal(
    report.application_matrix.reduce((total, item) => total + item.actual_tool_calls, 0),
    30,
  );
  report.checks.push({
    name: '启动/停止/重置三个入口各HTTP/MCP，自动ability一Job两顺序工具且同父插件',
    passed: true,
    cases: report.application_matrix.map((item) => item.case_id),
    jobs: 24,
    tools: 30,
  });
}

export async function applicationInputErrors(host, fixture, report) {
  const before = await keys(fixture),
    baseline = await jobList(host),
    cases = [];
  for (const name of appNames) {
    const inputs = [
      {},
      { bundle: null },
      { bundle: '' },
      { bundle: '--bad' },
      { bundle: 'com.smoke;echo' },
      { bundle, unexpected: true },
      ...(name === 'app.start'
        ? [
            { bundle, ability: null },
            { bundle, ability: '' },
            { bundle, ability: 'bad ability' },
            { bundle, flags: ['-D'] },
          ]
        : [{ bundle, ability }]),
    ];
    for (let index = 0; index < inputs.length; index++)
      for (const point of ['capability', 'direct', 'alias']) {
        const input = inputs[index],
          caseId = `应用输入-${name}-${point}-${index}`;
        const client = host.client.scope({ case_id: caseId, phase: 'reject' });
        const value =
          point === 'capability'
            ? action(report.provider, name, localId, input)
            : point === 'alias'
              ? { device_id: localId, ...input }
              : envelope(localId, input);
        if (point === 'capability') {
          await client.post('/api/v2/device-actions', value, {
            status: 400,
            code: 'invalid_input',
          });
          await client.tool('deviceforge.invoke_device', value, 'invalid_input');
        } else {
          await client.post(
            '/api/v2/jobs',
            { operation: point === 'alias' ? alias(name) : operation(name), input: value },
            { status: 400, code: 'invalid_input' },
          );
          await client.tool(
            point === 'alias' ? alias(name) : operation(name),
            value,
            'invalid_input',
          );
        }
        cases.push({
          case_id: caseId,
          name,
          point,
          expected_http_status: 400,
          expected_code: 'invalid_input',
        });
      }
  }
  assert.deepEqual(await jobList(host), baseline);
  assert.deepEqual(await keys(fixture), before);
  report.application_input_errors = cases;
  report.checks.push({
    name: '三应用动作缺失/null/非法标识/未知业务字段HTTP/MCP精确拒绝，零Job零HDC',
    passed: true,
    cases: cases.length,
  });
}
