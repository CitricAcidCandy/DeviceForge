import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtures } from './ordinary-deadline/fixtures.mjs';
import { collectKnownProcesses } from './ordinary-deadline-http/process-evidence.mjs';
import { verifyPackageBytes } from './ordinary-deadline-http/packages.mjs';
import { passed, recordFailure, stage, verifyLogs } from './ordinary-deadline-http/evidence.mjs';
import { prepareNpx } from './ordinary-deadline-npx/host.mjs';
import { preserveArchive, runtimeIdentity, verifyRuntimeUnchanged, verifyHostLifecycleLogs } from './ordinary-deadline-npx/identity.mjs';
import { installPackages } from './ordinary-deadline-npx/packages.mjs';
import { captureBaseline } from './ordinary-deadline-npx/history.mjs';
import { verifyCases } from './ordinary-deadline-npx/cases.mjs';
import { createNpxReport, checkpointFailure, retainNpxEvidence, writeNpxReport } from './ordinary-deadline-npx/evidence.mjs';

// 正式归档由主代理准备；本入口不构建、不打包、不覆盖现有运行资源。
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--archive' && args[1], '需要 --archive 指定已有正式CLI原TGZ');
const archive = resolve(args[1]);
await mkdir(join(root, 'artifacts'), { recursive: true });
const reportDirectory = await mkdtemp(join(root, 'artifacts', 'ordinary-deadline-npx-'));
const report = createNpxReport(reportDirectory);
report.command = { entry: 'node scripts/ordinary-deadline-npx-smoke.mjs', archive };
report.platform = process.platform; report.architecture = process.arch;
let temporary, host, runtime;
let items = [];
let completed = false;

try {
  await stage(report, '保留本次执行的正式原TGZ与两协议夹具', async () => {
    await preserveArchive(archive, report);
    temporary = await mkdtemp(join(tmpdir(), 'deviceforge-ordinary-deadline-npx-'));
    report.temporary_directory = temporary;
    items = await createFixtures(temporary, report);
  });
  await stage(report, '真实npx默认无token与独立HTTP/MCP端口', async () => {
    host = await prepareNpx({ root, temporary, archive, report });
    host.start(); await host.ready();
    runtime = await runtimeIdentity(host, report);
    passed(report, '原TGZ/全成员缓存/解析shim/served字节及默认LAN启动');
  });
  // 公开基线在宿主就绪后、本批8Job开始前采集，不读取私有SQLite或猜测旧库为空。
  const baseline = await stage(report, '本批Job启动前公开基线', () => captureBaseline(host.client, report));
  await stage(report, '真实CLI安装两协议包与预算目录', async () => {
    await installPackages(host, items, temporary, report);
    passed(report, '真实npx安装/显式load/HTTP-MCP有效预算');
  });
  await verifyCases(host, items, baseline, report);
  await stage(report, 'HTTP shutdown200/npx零退出/双端口独立释放', async () => {
    await host.shutdown();
    passed(report, '正常npx exit0与HTTP/MCP端口释放');
  });
  await stage(report, '正式归档/缓存身份稳定与本批8Job落盘', async () => {
    await verifyPackageBytes(report);
    await verifyRuntimeUnchanged(host, runtime, report);
    await verifyLogs(host.directory, host, report);
    await verifyHostLifecycleLogs(host, report);
    passed(report, '8Job/request/提交logID关联与正常宿主日志');
  });
  completed = true;
} catch (error) {
  recordFailure(report, error);
  process.exitCode = 1;
  await checkpointFailure(report);
} finally {
  if (host) {
    try { await host.finish(); }
    catch (error) {
      recordFailure(report, error);
      report.cleanup_error = { name: error.name, code: error.code };
      completed = false; process.exitCode = 1;
    }
    if (!completed) {
      await collectKnownProcesses(items, report);
      if (runtime) {
        try { await verifyRuntimeUnchanged(host, runtime, report); }
        catch (error) { report.failure_identity_error = { name: error.name, code: error.code }; }
      }
    }
  }
  report.passed = completed && report.failure_stage === undefined;
  if (temporary) {
    try { await retainNpxEvidence(temporary, items, report); }
    catch (error) {
      recordFailure(report, error); report.retention_error = { name: error.name, code: error.code };
      process.exitCode = 1;
    }
  }
  report.stage = report.passed ? '完成' : report.stage;
  const saved = await writeNpxReport(root, report);
  console.log(JSON.stringify({ passed: report.passed, report: saved.path, index: saved.index,
    new_jobs: report.jobs.length, failure_stage: report.failure_stage,
    temporary_retained: report.temporary_retained, rust_pid_directly_collected: false }));
  if (!report.passed) process.exitCode = 1;
}
