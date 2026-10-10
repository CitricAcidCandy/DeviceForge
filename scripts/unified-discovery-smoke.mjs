import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAdmission } from './unified-discovery-smoke/admission.mjs';
import { verifyEntries, verifyInvalidInputs } from './unified-discovery-smoke/checks.mjs';
import { createReport, fileIdentity, recordFailure, retainFailureEvidence, stage, verifyPersistedLogs, writeReport } from './unified-discovery-smoke/evidence.mjs';
import { assertListenerReleased, finishOwnHost, reservePort, startHost, stopHost } from './unified-discovery-smoke/host.mjs';
import { inputs } from './unified-discovery-smoke/inputs.mjs';
import { verifyLifecycle, verifyRestart } from './unified-discovery-smoke/lifecycle.mjs';
import { verifyAllProcesses, verifyRaw } from './unified-discovery-smoke/raw.mjs';

// 只运行主代理已构建二进制；不调用Cargo/npm，不导入宿主内部生产实现。
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every((arg) => arg === '--release'), '只接受一个可选--release');
const profile = args.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend', 'target', profile, `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
const report = createReport(profile, `node scripts/unified-discovery-smoke.mjs${profile === 'release' ? ' --release' : ''}`);
let directory, fixtures, context;
const hosts = [];
let completed = false;

try {
  await stage(report, '当前宿主与本次夹具字节', async () => {
    report.host = await fileIdentity(binary);
    directory = await mkdtemp(join(tmpdir(), 'deviceforge-unified-discovery-smoke-'));
    fixtures = await inputs(directory, report);
  });
  const port = await reservePort();
  await stage(report, '真实空部署默认免鉴权启动', async () => {
    const host = await startHost({ root, binary, directory, bindingsPath: fixtures.path, report, port, ordinal: 1 });
    hosts.push(host);
    await host.ready();
    context = { host, client: host.client, fixtures, report };
  });
  await stage(report, '安装验证与profile加载拒绝分层', () => verifyAdmission(context));
  await stage(report, '三入口乘HTTP/MCP一Job一真实执行', () => verifyEntries(context));
  await stage(report, '坏业务输入零Job、零执行与旧目录保持', () => verifyInvalidInputs(context));
  await stage(report, 'API1/2/3原文兼容、整份观测与format2旧数组', () => verifyRaw(context));
  await stage(report, '取消、热卸载、旧代与历史证据', () => verifyLifecycle(context));
  await stage(report, '首次真实宿主正常退出与监听释放', async () => {
    await stopHost(hosts[0]);
    await assertListenerReleased(port);
    await verifyAllProcesses(fixtures.all, report);
  });
  await stage(report, '同一部署及SQLite真实Rust进程重启', async () => {
    const host = await startHost({ root, binary, directory, bindingsPath: fixtures.path, report, port, ordinal: 2 });
    hosts.push(host);
    assert.equal(host.entry.binary.sha256, report.host.sha256, '重启不得偷偷换宿主字节');
    await host.ready();
    context.host = host; context.client = host.client;
    await verifyRestart(context);
  });
  await stage(report, '重启宿主正常退出、全部进程及日志关联落盘', async () => {
    await stopHost(hosts[1]);
    await assertListenerReleased(port);
    await verifyAllProcesses(fixtures.all, report);
    await verifyPersistedLogs(directory, hosts.map((host) => host.client), report);
  });
  completed = true;
} catch (error) {
  recordFailure(report, error);
  process.exitCode = 1;
} finally {
  // 所有清理均保留首次业务失败的阶段/请求；任何清理失败也禁止删证据。
  for (const host of hosts) {
    try { await finishOwnHost(host); }
    catch (error) {
      recordFailure(report, error);
      report.cleanup_errors ??= [];
      report.cleanup_errors.push({ host_ordinal: host.entry.ordinal, message: String(error.message).slice(0, 1000) });
      completed = false; process.exitCode = 1;
    }
  }
  if (fixtures) {
    try { await verifyAllProcesses(fixtures.all, report); }
    catch (error) {
      recordFailure(report, error);
      report.process_evidence_error = String(error.message).slice(0, 1000);
      completed = false; process.exitCode = 1;
    }
  }
  if (directory && completed && report.failure_stage === undefined) {
    try {
      report.stage = '本次临时目录清理';
      const temporary = resolve(directory), parent = resolve(tmpdir()), within = relative(parent, temporary);
      assert.ok(within && !within.startsWith('..') && !isAbsolute(within)
        && temporary.startsWith(join(parent, 'deviceforge-unified-discovery-smoke-')), '删除前核对本次绝对临时目录边界');
      await rm(temporary, { recursive: true, force: true });
      report.temporary_removed = true;
      report.stage = '完成'; report.passed = true;
    } catch (error) {
      recordFailure(report, error); process.exitCode = 1;
    }
  }
  if (directory && !report.passed) await retainFailureEvidence(directory, report);
  report.exit_code = process.exitCode ?? 0;
  const path = await writeReport(root, report);
  console.log(JSON.stringify({ ...report, report_path: path }, null, 2));
}
