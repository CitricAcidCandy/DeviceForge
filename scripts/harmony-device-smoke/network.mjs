import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { action, envelope, noFallback, submitAction } from './actions.mjs';
import { emptyScratch } from './artifacts.mjs';
import { catalog } from './bootstrap.mjs';
import { alias, operation, pluginId, providerCapabilities } from './deployment.mjs';
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
import { jobList, preserveHistory, record, submit } from './jobs.mjs';
import { owner, plugins } from './lifecycle.mjs';

export const networkAddress = 'localhost:5555';
const networkArgv = (name, address = networkAddress) =>
  name === 'connect' ? ['tconn', address] : ['tconn', address, '-remove'];
const networkResult = (entry, result) =>
  entry.network_point === 'alias' ? result : { result, artifacts: [] };

async function submitNetwork(
  host,
  report,
  { caseId, name, point, transport, address = networkAddress },
) {
  const input = { address };
  const entry =
    point === 'capability'
      ? await submitAction(
          host,
          report,
          caseId,
          action(report.provider, name, null, input),
          transport,
        )
      : await submit(
          host,
          report,
          caseId,
          point === 'alias' ? alias(name) : operation(name),
          point === 'alias' ? input : envelope(null, input),
          transport,
        );
  entry.network_point = point;
  entry.network_name = name;
  entry.network_address = address;
  return entry;
}

export async function networkEntry(host, fixture, report, request) {
  const before = await keys(fixture),
    baseline = await jobList(host);
  await setMode(fixture, request.mode ?? 'normal');
  const entry = await submitNetwork(host, report, request),
    job = await record(host, entry);
  const previous = new Set(baseline.map((item) => item.id));
  assert.deepEqual(
    (await jobList(host)).filter((item) => !previous.has(item.id)).map((item) => item.id),
    [entry.job_id],
  );
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  assert.equal(added.length, 1, 'HD-NETWORK-ONE-TOOL:' + request.caseId);
  assert.deepEqual(added[0].ready.argv, networkArgv(entry.network_name, entry.network_address));
  entry.tool = await finishedTool(added[0]);
  assert.deepEqual(
    job.result,
    networkResult(entry, {
      output: request.expected ?? (request.name === 'connect' ? 'Connect OK' : ''),
    }),
  );
  assert.equal(job.error, null);
  await emptyScratch(fixture);
  return entry;
}

export async function networkBeforeDiscovery(host, fixture, report) {
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  const entries = [];
  for (const point of ['capability', 'direct', 'alias'])
    for (const transport of ['http', 'mcp']) {
      for (const [name, mode, expected] of [
        ['connect', 'normal', 'Connect OK'],
        ['connect', 'network-repeat', '[Info]Target is connected, repeat operation'],
        ['disconnect', 'normal', ''],
      ]) {
        entries.push(
          await networkEntry(host, fixture, report, {
            caseId: `未发现网络-${name}-${mode}-${point}-${transport}`,
            name,
            point,
            transport,
            mode,
            expected,
          }),
        );
        assert.deepEqual(await host.client.json('/api/v2/devices'), []);
        assert.deepEqual(await host.client.tool('deviceforge.list_devices'), []);
      }
    }
  report.network_matrix = entries.map((entry) => ({
    case_id: entry.case_id,
    point: entry.network_point,
    name: entry.network_name,
    transport: entry.transport,
    job_id: entry.job_id,
    expected_tool_calls: 1,
  }));
  report.checks.push({
    name: '无发现目录的新连接/重复/静默断开，三入口双协议18Job/18工具且无自动目录变更',
    passed: true,
    jobs: entries.map((entry) => entry.job_id),
  });
  await setMode(fixture, 'normal');
}

async function rejectNetwork(host, report, caseId, name, point, input) {
  const client = host.client.scope({ case_id: caseId, phase: 'reject' });
  if (point === 'capability') {
    await client.post('/api/v2/device-actions', input, { status: 400, code: 'invalid_input' });
    await client.tool('deviceforge.invoke_device', input, 'invalid_input');
  } else {
    const id = point === 'alias' ? alias(name) : operation(name);
    await client.post(
      '/api/v2/jobs',
      { operation: id, input },
      { status: 400, code: 'invalid_input' },
    );
    await client.tool(id, input, 'invalid_input');
  }
  report.network_schema_requests += 2;
}

export async function networkInputErrors(host, fixture, report) {
  const before = await jobList(host),
    previous = await keys(fixture);
  const samples = [
    {},
    { address: null },
    { address: 7 },
    { address: '' },
    { address: 'example.com:5555' },
    { address: '[::1]:5555' },
    { address: networkAddress, unexpected: true },
    { address: 'localhost:5555;id' },
    { address: 'localhost' },
  ];
  report.network_schema_requests = 0;
  for (const name of providerCapabilities)
    for (const point of ['capability', 'direct', 'alias']) {
      for (let index = 0; index < samples.length; index++) {
        const value =
          point === 'capability'
            ? action(report.provider, name, null, samples[index])
            : point === 'alias'
              ? samples[index]
              : envelope(null, samples[index]);
        await rejectNetwork(host, report, `网络形状-${name}-${point}-${index}`, name, point, value);
      }
      const value =
        point === 'capability'
          ? action(report.provider, name, localId, { address: networkAddress })
          : point === 'alias'
            ? { device_id: localId, address: networkAddress }
            : envelope(localId, { address: networkAddress });
      await rejectNetwork(host, report, `网络设备范围-${name}-${point}`, name, point, value);
    }
  for (const name of providerCapabilities)
    for (const input of [{ input: { address: networkAddress } }, { device_id: null }]) {
      await rejectNetwork(
        host,
        report,
        `网络缺显式封套-${name}-${Object.keys(input)[0]}`,
        name,
        'direct',
        input,
      );
    }
  assert.equal(report.network_schema_requests, 128);
  assert.deepEqual(await jobList(host), before);
  assert.deepEqual(await keys(fixture), previous);
  report.checks.push({
    name: '网络shape/null/作用域与严格业务schema双协议128拒绝请求，零Job零工具',
    passed: true,
    requests: report.network_schema_requests,
  });
}

export async function networkSemanticErrors(host, fixture, report) {
  const entries = [];
  for (const [name, address, expected] of [
    ['connect', '256.0.0.1:5555', '依赖执行失败：输入无效：连接主机须为规范IPv4或字面localhost'],
    ['connect', '127.00.0.1:5555', '依赖执行失败：输入无效：连接主机须为规范IPv4或字面localhost'],
    ['disconnect', 'localhost:0', '依赖执行失败：输入无效：连接端口须为1至65535的ASCII十进制数字'],
    [
      'disconnect',
      'localhost:65536',
      '依赖执行失败：输入无效：连接端口须为1至65535的ASCII十进制数字',
    ],
  ])
    for (const point of ['capability', 'direct', 'alias'])
      for (const transport of ['http', 'mcp']) {
        const before = await keys(fixture),
          baseline = await jobList(host);
        const entry = await submitNetwork(host, report, {
          caseId: `网络语义-${name}-${address}-${point}-${transport}`,
          name,
          address,
          point,
          transport,
        });
        const job = await record(host, entry, 'failed');
        assert.equal(job.result, null);
        assert.equal(job.error, expected);
        assert.deepEqual(await keys(fixture), before);
        const previous = new Set(baseline.map((item) => item.id));
        assert.deepEqual(
          (await jobList(host)).filter((item) => !previous.has(item.id)).map((item) => item.id),
          [entry.job_id],
        );
        entry.semantic_validation_before_tool = true;
        entries.push(entry);
      }
  report.network_semantic_jobs = entries.map((entry) => entry.job_id);
  report.checks.push({
    name: '四个数值语义地址跨三入口双协议，24真实失败Job但零HDC',
    passed: true,
    jobs: report.network_semantic_jobs,
  });
}

export async function networkFailures(host, fixture, report) {
  const entries = [];
  for (const name of providerCapabilities)
    for (const [mode, point, transport, expected] of [
      ['network-fail-stdout', 'capability', 'http', '依赖执行失败：工具依赖失败：HDC返回失败诊断'],
      ['network-fail-stderr', 'capability', 'mcp', '依赖执行失败：工具依赖失败：HDC返回失败诊断'],
      ['network-stdout-utf8', 'direct', 'http', '依赖执行失败：工具依赖失败：HDC输出不是有效UTF-8'],
      ['network-stderr-utf8', 'direct', 'mcp', '依赖执行失败：工具依赖失败：HDC输出不是有效UTF-8'],
      [
        'network-nonzero',
        'alias',
        'http',
        '依赖执行失败：工具依赖失败：HDC客户端执行失败，请检查部署配置',
      ],
      [
        name === 'connect' ? 'network-empty' : 'network-unknown',
        'alias',
        'mcp',
        name === 'connect'
          ? '依赖执行失败：工具依赖失败：HDC未返回明确连接成功结果'
          : '依赖执行失败：工具依赖失败：HDC断开返回不支持的非静默响应',
      ],
    ]) {
      const before = await keys(fixture);
      await setMode(fixture, mode);
      const entry = await submitNetwork(host, report, {
        caseId: `网络工具失败-${name}-${mode}`,
        name,
        point,
        transport,
      });
      const job = await record(host, entry, 'failed'),
        added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
      assert.equal(job.result, null);
      assert.equal(job.error, expected);
      assert.equal(added.length, 1);
      assert.deepEqual(added[0].ready.argv, networkArgv(name));
      entry.tool = await finishedTool(added[0], { intentCode: mode === 'network-nonzero' ? 7 : 0 });
      entries.push(entry);
    }
  await setMode(fixture, 'normal');
  report.network_failure_jobs = entries.map((entry) => entry.job_id);
  report.checks.push({
    name: '两提供者能力的两流失败优先/未知目标/UTF8/非零/未知响应12Job与固定单工具',
    passed: true,
    jobs: report.network_failure_jobs,
  });
}

async function toolFor(fixture, before, argv) {
  const matching = (await observations(fixture)).filter(
    (item) =>
      !before.includes(item.directory) && JSON.stringify(item.ready.argv) === JSON.stringify(argv),
  );
  assert.equal(matching.length, 1, 'HD-NETWORK-MATCHED-ARGV');
  return matching[0];
}

export async function networkSharedLocks(host, fixture, report) {
  const entries = [],
    before = await keys(fixture);
  await setMode(fixture, 'network-hold');
  const first = await submitNetwork(host, report, {
    caseId: 'provider屏障首连接',
    name: 'connect',
    point: 'capability',
    transport: 'http',
  });
  const held = await started(fixture, before, networkArgv('connect'));
  await setMode(fixture, 'normal');
  const second = await submitNetwork(host, report, {
    caseId: '同provider断开direct等待',
    name: 'disconnect',
    point: 'direct',
    transport: 'mcp',
  });
  const read = await submitAction(
    host,
    report,
    'provider屏障设备读取等待',
    action(report.provider, 'packages', localId),
    'mcp',
  );
  const write = await submit(
    host,
    report,
    'provider屏障另一设备写入alias等待',
    alias('app.stop'),
    { device_id: otherId, bundle: 'com.smoke.harmony' },
    'http',
  );
  await delay(100);
  assert.equal((await host.client.job(first.job_id)).status, 'running');
  assert.deepEqual(
    await keys(fixture),
    [...before, held.directory].sort(),
    'HD-NETWORK-PROVIDER-BLOCKS-ALL',
  );
  await release(held);
  for (const [entry, argv, expected] of [
    [first, networkArgv('connect'), { result: { output: 'Connect OK' }, artifacts: [] }],
    [second, networkArgv('disconnect'), { result: { output: '' }, artifacts: [] }],
    [
      read,
      ['-t', localId, 'shell', 'bm', 'dump', '-a'],
      { result: { output: 'com.alpha.app\ncom.beta.app' }, artifacts: [] },
    ],
    [
      write,
      ['-t', otherId, 'shell', 'aa', 'force-stop', 'com.smoke.harmony'],
      { output: 'force stop process successfully.' },
    ],
  ]) {
    await record(host, entry);
    entry.tool = await finishedTool(await toolFor(fixture, before, argv));
    assert.deepEqual(entry.history.result, expected);
    assert.equal(entry.history.error, null);
    entries.push(entry);
    if (entry !== first)
      assert.ok(BigInt(entry.tool.ready.unix_ns) >= BigInt(first.tool.completed.unix_ns));
  }
  assert.equal((await keys(fixture)).filter((directory) => !before.includes(directory)).length, 4);

  const reverseBefore = await keys(fixture);
  await setMode(fixture, 'hold');
  const heldRead = await submitAction(
    host,
    report,
    '设备读取屏障首任务',
    action(report.provider, 'packages', localId),
    'http',
  );
  const readTool = await started(fixture, reverseBefore, [
    '-t',
    localId,
    'shell',
    'bm',
    'dump',
    '-a',
  ]);
  const writeBefore = await keys(fixture);
  const heldWrite = await submit(
    host,
    report,
    '另一设备写入屏障首任务',
    operation('app.stop'),
    envelope(otherId, { bundle: 'com.smoke.harmony' }),
    'mcp',
  );
  const writeTool = await started(fixture, writeBefore, [
    '-t',
    otherId,
    'shell',
    'aa',
    'force-stop',
    'com.smoke.harmony',
  ]);
  await setMode(fixture, 'normal');
  const waiting = await submitNetwork(host, report, {
    caseId: '两设备读写在途provider连接alias等待',
    name: 'connect',
    point: 'alias',
    transport: 'mcp',
  });
  const heldKeys = [...reverseBefore, readTool.directory, writeTool.directory].sort();
  await delay(100);
  assert.deepEqual(await keys(fixture), heldKeys, 'HD-NETWORK-DEVICE-BLOCKS-PROVIDER');
  await release(readTool);
  await record(host, heldRead);
  heldRead.tool = await finishedTool(readTool);
  assert.deepEqual(heldRead.history.result, {
    result: { output: 'com.alpha.app\ncom.beta.app' },
    artifacts: [],
  });
  await delay(100);
  assert.deepEqual(await keys(fixture), heldKeys, 'HD-NETWORK-ONE-DEVICE-STILL-BLOCKS');
  await release(writeTool);
  await record(host, heldWrite);
  heldWrite.tool = await finishedTool(writeTool);
  assert.deepEqual(heldWrite.history.result, {
    result: { output: 'force stop process successfully.' },
    artifacts: [],
  });
  await record(host, waiting);
  waiting.tool = await finishedTool(await toolFor(fixture, reverseBefore, networkArgv('connect')));
  assert.deepEqual(waiting.history.result, { output: 'Connect OK' });
  for (const entry of [heldRead, heldWrite])
    assert.ok(BigInt(waiting.tool.ready.unix_ns) >= BigInt(entry.tool.completed.unix_ns));
  assert.equal(
    (await keys(fixture)).filter((directory) => !reverseBefore.includes(directory)).length,
    3,
  );
  entries.push(heldRead, heldWrite, waiting);
  report.network_lock_jobs = entries.map((entry) => entry.job_id);
  await emptyScratch(fixture);
  report.checks.push({
    name: 'provider写屏障双向冲突设备读写、同provider串行，七Job七实际工具',
    passed: true,
    jobs: report.network_lock_jobs,
    boundary: '当前provider的离散任务屏障；不声称外部HDC客户端全局锁或改变既有设备读写并行语义',
  });
}

export async function networkCancellation(host, fixture, report) {
  const entries = [];
  for (const [name, point, transport] of [
    ['connect', 'capability', 'http'],
    ['disconnect', 'alias', 'mcp'],
  ]) {
    const before = await keys(fixture);
    await setMode(fixture, 'network-hold');
    const entry = await submitNetwork(host, report, {
      caseId: `网络在途取消-${name}`,
      name,
      point,
      transport,
    });
    const tool = await started(fixture, before, networkArgv(name));
    await host.client
      .scope({ case_id: entry.case_id, phase: 'cancel' })
      .post('/api/v2/jobs/' + entry.job_id + '/cancel');
    await record(host, entry, 'cancelled');
    assert.equal(entry.history.result, null);
    entry.tool = await finishedTool(tool, { cancelled: true });
    await assert.rejects(lstat(join(tool.directory, 'release')), { code: 'ENOENT' });
    assert.deepEqual(
      await keys(fixture),
      [...before, tool.directory].sort(),
      'HD-NETWORK-CANCEL-NO-COMPENSATION',
    );
    entries.push(entry);
  }
  await setMode(fixture, 'normal');
  await emptyScratch(fixture);
  report.network_cancel_jobs = entries.map((entry) => entry.job_id);
  report.checks.push({
    name: '连接/断开在途取消唯一终态、本次客户端退出且无daemon或反向补偿命令',
    passed: true,
    jobs: report.network_cancel_jobs,
  });
}

export async function networkLifecycle(host, deployment, fixture, report) {
  await plugins(host);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  const loaded = owner(
    await host.client.post('/api/v2/plugins/' + pluginId + '/load'),
    deployment,
    undefined,
    'loaded',
  );
  report.generations.network_first = loaded.generation;
  await plugins(host, loaded);
  await catalog(host, deployment, report, '网络独立卸载首次加载', true, loaded);
  const old = structuredClone(report.provider),
    before = await keys(fixture);
  await setMode(fixture, 'network-hold');
  const held = await submitNetwork(host, report, {
    caseId: '无发现连接在途卸载',
    name: 'connect',
    point: 'direct',
    transport: 'http',
  });
  const tool = await started(fixture, before, networkArgv('connect'));
  owner(
    await host.client.tool('deviceforge.unload_plugin', { id: pluginId }),
    deployment,
    old.generation,
    'unloaded',
  );
  await record(host, held, 'cancelled');
  held.tool = await finishedTool(tool, { cancelled: true });
  assert.equal(held.history.result, null);
  await assert.rejects(lstat(join(tool.directory, 'release')), { code: 'ENOENT' });
  assert.deepEqual(
    await keys(fixture),
    [...before, tool.directory].sort(),
    'HD-NETWORK-UNLOAD-NO-COMPENSATION',
  );
  report.network_unload_job = held.job_id;
  await plugins(host);
  await catalog(host, deployment, report, '网络在途卸载后', false);
  await noFallback(host, fixture, report, '网络在途卸载后');
  await preserveHistory(host, report, '网络在途卸载后');
  await setMode(fixture, 'normal');
  const reloaded = owner(
    await host.client.post('/api/v2/plugins/' + pluginId + '/load'),
    deployment,
    undefined,
    'loaded',
  );
  assert.notEqual(reloaded.generation, old.generation);
  report.generations.network_second = reloaded.generation;
  await plugins(host, reloaded);
  await catalog(host, deployment, report, '网络独立换代', true, reloaded);
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  const baseline = await jobList(host),
    previous = await keys(fixture);
  for (const name of providerCapabilities) {
    const stale = action(old, name, null, { address: networkAddress });
    await host.client.post('/api/v2/device-actions', stale, { status: 409, code: 'conflict' });
    await host.client.tool('deviceforge.invoke_device', stale, 'conflict');
  }
  assert.deepEqual(await jobList(host), baseline);
  assert.deepEqual(await keys(fixture), previous);
  const current = await networkEntry(host, fixture, report, {
    caseId: '新代无发现目录断开-MCP',
    name: 'disconnect',
    point: 'capability',
    transport: 'mcp',
  });
  report.reloaded_network_job = current.job_id;
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  owner(
    await host.client.post('/api/v2/plugins/' + pluginId + '/unload'),
    deployment,
    reloaded.generation,
    'unloaded',
  );
  await plugins(host);
  await catalog(host, deployment, report, '网络最终卸载后', false);
  await noFallback(host, fixture, report, '网络最终卸载后');
  await preserveHistory(host, report, '网络最终卸载后');
  await emptyScratch(fixture);
  report.checks.push({
    name: '无发现连接在途卸载、两provider旧代双协议拒绝、新代无发现断开及十贡献撤销',
    passed: true,
    jobs: [held.job_id, current.job_id],
    old_generation: old.generation,
    new_generation: reloaded.generation,
  });
}
