import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertRecoveryView, createHttp, recoverySummary } from './http.mjs';
import { caseDefinitions, parseOptions } from './options.mjs';
import { driverIdentities } from './freeze.mjs';
import { pendingContract } from './recovery-contract.mjs';
import { bounded } from '../unified-discovery-browser/lifecycle.mjs';
import { isFaultCallName } from './fault-processes.mjs';
import { failureSummary } from './evidence.mjs';

const generation = randomUUID();
const reportValue = () => ({ status: 'recovered', coverage: 'plugin', inspected: 1, remaining: 0,
  message: '已核对', checks: [{ resource: 'fixture', status: 'confirmed', message: '已释放' }] });
const view = () => ({ id: 'mirroring', generation, supported: true,
  cleanup_failed: false, recovering: false, last_report: reportValue() });
const required = ['--frozen-input=host', '--plugin-input=plugin', '--tool=tool.exe', '--probe=probe.exe'];

test('参数严格校验且默认选择所有冻结案例', () => {
  assert.equal(parseOptions(['--help']).help, true);
  assert.equal(parseOptions(required).selected.length, caseDefinitions.length);
  assert.equal(parseOptions([...required, '--case=active-session-busy']).selected.length, 1);
  for (const extra of [['--what=x'], ['--case='], ['--case=nope'], ['--tool=another'], ['--server-version=9']])
    assert.throws(() => parseOptions([...required, ...extra]));
  assert.throws(() => parseOptions(required.slice(1)));
  assert.throws(() => parseOptions([...required, '--browser-dist=dist']));
  assert.ok(parseOptions([...required, '--case=explicit-recovery', '--browser-dist=dist']).browserDist);
});

test('合法恢复视图与插件级覆盖合同', () => {
  const value = view();
  assert.equal(assertRecoveryView(value, { generation, supported: true }), value);
  const empty = { ...value, last_report: null };
  assertRecoveryView(empty);
  assertRecoveryView({ ...value, cleanup_failed: true, last_report: {
    ...reportValue(), status: 'blocked', remaining: 1, checks: [{ resource: 'B', status: 'blocked', message: '仍未释放' }],
  } });
});

for (const key of ['coverage', 'inspected', 'remaining']) {
  test('缺失必填报告字段须拒绝：' + key, () => {
    const value = view(); delete value.last_report[key];
    assert.throws(() => assertRecoveryView(value));
  });
}

for (const coverage of ['', 'device', null]) {
  test('不允许局部或空覆盖：' + String(coverage), () => {
    const value = view(); value.last_report.coverage = coverage;
    assert.throws(() => assertRecoveryView(value));
  });
}

for (const key of ['inspected', 'remaining']) {
  test('覆盖计数须为 u32：' + key, () => {
    for (const invalid of [-1, 0.5, 0x100000000, '1', null, Number.NaN]) {
      const value = view(); value.last_report[key] = invalid;
      assert.throws(() => assertRecoveryView(value));
    }
  });
}

test('空检查、部分确认和剩余债务不能伪装成功', () => {
  const empty = view(); empty.last_report.checks = [];
  assert.throws(() => assertRecoveryView(empty));
  for (const status of ['busy', 'blocked']) {
    const value = view(); value.last_report.checks[0].status = status;
    assert.throws(() => assertRecoveryView(value));
  }
  const remaining = view(); remaining.last_report.remaining = 1;
  assert.throws(() => assertRecoveryView(remaining));
  const flag = view(); flag.cleanup_failed = true;
  assert.throws(() => assertRecoveryView(flag, { freshReport: true }));
});

test('新故障不得被历史成功报告覆盖，但历史报告本身仍可合法返回', () => {
  const value = view(); value.cleanup_failed = true;
  assertRecoveryView(value);
  assert.equal(recoverySummary(value).cleanup_failed, true);
  assert.throws(() => assertRecoveryView(value, { freshReport: true }));
});

test('摘要不泄露任意资源消息', () => {
  const value = view(); value.last_report.message = '不进入报告的业务正文';
  value.last_report.checks[0].message = '不进入报告的错误正文';
  assert.equal(JSON.stringify(recoverySummary(value)).includes('正文'), false);
  assert.equal(recoverySummary(value).last_report.coverage, 'plugin');
});

test('断言摘要保留真实源文件行列，拒绝复制任意异常正文', () => {
  let failure;
  try { assert.equal(true, false, '不可归档的正文'); } catch (error) { failure = error; }
  const summary = failureSummary(failure, '驱动自检');
  assert.ok(summary.source.path.endsWith('self-test.mjs'));
  assert.ok(summary.source.line > 0 && summary.source.column > 0);
  assert.equal(summary.actual, true); assert.equal(summary.expected, false);
  assert.equal(JSON.stringify(summary).includes('不可归档的正文'), false);
});

test('HTTP 严禁用户端口、外部地址及跨域路径', async () => {
  for (const origin of ['http://127.0.0.1:7031', 'http://127.0.0.1:5173', 'http://localhost:33445', 'https://127.0.0.1:33445'])
    assert.throws(() => createHttp(origin, {}));
  const client = createHttp('http://127.0.0.1:33445', {}, { fetcher: async () => { throw new Error('不应请求'); } });
  await assert.rejects(client.call('https://example.test/api/v2/health'));
});

test('恢复 POST 不自动重试，日志关联但不保存请求体', async () => {
  let calls = 0;
  const report = {}, id = randomUUID();
  const client = createHttp('http://127.0.0.1:33445', report, { fetcher: async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/api/v2/plugins/mirroring/recovery');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { generation, input: { device_id: 'synthetic' } });
    return new Response(JSON.stringify({ log_id: id, data: view() }), {
      headers: { 'content-type': 'application/json', 'x-deviceforge-log-id': id },
    });
  } });
  assertRecoveryView(await client.recover(generation, 'synthetic'));
  assert.equal(calls, 1);
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0].log_id, id);
  assert.equal(JSON.stringify(report).includes('synthetic'), false);
  assert.equal(client.logIds.has(id), true);
});

test('请求失败不重试，错误原文不写摘要', async () => {
  let calls = 0;
  const report = {};
  const client = createHttp('http://127.0.0.1:33445', report, { fetcher: async () => {
    calls++; throw new Error('敏感正文不得归档');
  } });
  await assert.rejects(client.recover(generation, 'synthetic'));
  assert.equal(calls, 1);
  assert.equal(report.requests[0].outcome, 'threw');
  assert.equal(JSON.stringify(report).includes('敏感正文'), false);
});

test('错误日志关联必须失败，不能忽略响应头与正文不一致', async () => {
  const client = createHttp('http://127.0.0.1:33445', {}, { fetcher: async () =>
    new Response(JSON.stringify({ log_id: randomUUID(), data: view() }), {
      headers: { 'x-deviceforge-log-id': randomUUID() },
    }) });
  await assert.rejects(client.recovery());
});

test('待交接状态永远不算通过，且不启动进程', () => {
  const result = pendingContract('explicit-recovery');
  assert.equal(result.status, 'pending_contract');
  assert.equal(result.passed, false);
  assert.deepEqual(result.process_recovery.spawned, []);
});

test('故障进程目录扫描不得把 OS 探针自己的 ready 文件当成新插件', () => {
  const prefix = 'call-' + randomUUID();
  assert.equal(isFaultCallName(prefix + '.ready.json'), true);
  assert.equal(isFaultCallName(prefix + '.process.ready.json'), false);
  assert.equal(isFaultCallName(prefix + '.process.exit.json'), false);
  assert.equal(isFaultCallName(prefix + '.release'), false);
});

test('驱动冻结摘要包括递归导入的旧夹具与原生源，不依赖生产实现', async () => {
  const identities = await driverIdentities(fileURLToPath(new URL('../mirroring-recovery-smoke.mjs', import.meta.url)));
  assert.ok(identities.length >= 20);
  assert.ok(identities.some((item) => item.path.endsWith('socket_server.rs')));
  assert.ok(identities.some((item) => item.path.endsWith('process-probe.rs')));
  assert.ok(identities.some((item) => item.path.endsWith('fault-worker.mjs')));
  assert.equal(identities.some((item) => /backend[\\/]crates/.test(item.path)), false);
});

test('真实故障进程输出坏报告及挂住行为自检，不冒充宿主验收', async () => {
  const artifacts = fileURLToPath(new URL('../../artifacts/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'mirroring-recovery-driver-selftest-'));
  const evidence = { scope: '驱动故障进程自检；不含宿主、生产插件或真实设备', passed: false, processes: [] };
  try {
    for (const mode of ['coverage-omitted', 'checks-empty', 'hanging-after-report', 'protocol5-failed-cleanup']) {
      const root = join(directory, mode);
      await mkdir(root);
      await writeFile(join(root, 'fault-fixture-owner'), randomUUID(), { flag: 'wx' });
      await writeFile(join(root, 'mode'), mode, { flag: 'wx' });
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fault-worker.mjs', import.meta.url)), '--root=' + root],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const entry = { pid: child.pid, command: '本轮故障协议自检', mode };
      evidence.processes.push(entry);
      const closed = new Promise((done) => child.once('close', (code, signal) => { entry.exit = { code, signal }; done(entry.exit); }));
      child.once('error', () => {});
      const frames = [];
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => frames.push(JSON.parse(line)));
      let stderr = 0;
      child.stderr.on('data', (bytes) => { stderr += bytes.length; });
      try {
        const requestId = randomUUID();
        const protocol = mode === 'protocol5-failed-cleanup' ? 5 : 4;
        const identity = protocol === 5 ? { protocol_version: 5, session_id: requestId }
          : { protocol_version: 4, request_id: requestId };
        child.stdin.write(JSON.stringify({ ...identity,
          ...(protocol === 5 ? { command: 'open' } : {}),
          operation: protocol === 5 ? 'open' : 'runtime.recover', input: {} }) + '\n');
        let call;
        await bounded((async () => {
          while (!call) {
            call = (await readdir(root)).find((name) => name.endsWith('.ready.json'));
            if (!call) await delay(10);
          }
        })(), 3000, '自检未收到就绪记录');
        await writeFile(join(root, call.replace('.ready.json', '.release')), '1', { flag: 'wx' });
        await bounded((async () => { while (frames.length < 1) await delay(10); })(), 2000, '自检握手超时');
        assert.deepEqual(frames[0], { ...identity, command: 'ready' });
        child.stdin.write(JSON.stringify({ ...identity, command: 'start', remaining_timeout_ns: 2000000000 }) + '\n');
        await bounded((async () => { while (frames.length < 2) await delay(10); })(), 2000, '自检响应超时');
        if (protocol === 5) {
          assert.deepEqual(frames[1], { ...identity, event: 'output', sequence: 1, stream: 'stdout', bytes: [82] });
          child.stdin.write(JSON.stringify({ ...identity, command: 'cancel', reason: 'cancelled' }) + '\n');
          await bounded((async () => { while (frames.length < 3) await delay(10); })(), 2000, '自检清理终态超时');
          assert.deepEqual(frames[2], { ...identity, event: 'finished', sequence: 2, outcome: { result: null, cleanup: 'failed' } });
          assert.deepEqual(await bounded(closed, 2000, '自检协议5退出超时'), { code: 0, signal: null });
        } else if (mode !== 'hanging-after-report') {
          assert.throws(() => assertRecoveryView({ ...view(), last_report: frames[1].response.result }));
          assert.deepEqual(await bounded(closed, 2000, '自检退出超时'), { code: 0, signal: null });
        } else {
          await delay(80);
          assert.equal(child.exitCode, null, '挂住夹具不得发送成功即退出');
          entry.hang_observed = true;
          await writeFile(join(root, 'stop-fixture'), '1', { flag: 'wx' });
          assert.deepEqual(await bounded(closed, 2000, '挂住夹具自退超时'), { code: 96, signal: null });
        }
        entry.original_child_exit_confirmed = true;
        assert.equal(stderr, 0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          entry.forced_own_child_termination = true; child.kill();
          await bounded(closed, 2000, '自有自检进程回收超时');
        }
        lines.close();
      }
    }
    evidence.passed = true;
  } finally {
    await writeFile(join(directory, 'report.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    console.log('故障进程自检原件：' + directory);
  }
});
