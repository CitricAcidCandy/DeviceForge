import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtures } from './ordinary-deadline/fixtures.mjs';
import { prepareHost, reservePort } from './ordinary-deadline-http/host.mjs';
import { installFixtures, verifyPackageBytes } from './ordinary-deadline-http/packages.mjs';
import { verifyMatrix } from './ordinary-deadline-http/matrix.mjs';
import { collectKnownProcesses } from './ordinary-deadline-http/process-evidence.mjs';
import { createReport, passed, recordFailure, retainEvidence, stage, verifyLogs, writeReport } from './ordinary-deadline-http/evidence.mjs';

// 只使用主代理已构建的二进制，不调用 Cargo/npm 或启动第二个宿主。
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every((arg) => arg === '--release'), '只接受一个可选 --release');
const profile = args.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend', 'target', profile, `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
const report = createReport(profile);
report.command = `node scripts/ordinary-deadline-smoke.mjs${profile === 'release' ? ' --release' : ''}`;
report.platform = process.platform;
report.architecture = process.arch;
let directory, host;
let items = [];
let completed = false;

try {
  await stage(report, '本次真实包与控制根', async () => {
    directory = await mkdtemp(join(tmpdir(), 'deviceforge-ordinary-deadline-http-'));
    report.temporary_directory = directory;
    items = await createFixtures(directory, report);
  });
  await stage(report, '空目录真实宿主默认免令牌启动', async () => {
    const port = await reservePort();
    // 就绪前保存 spawn 句柄，启动失败也由本脚本 finally 收尾。
    host = await prepareHost({ root, binary, directory: join(directory, 'data'), report, port });
    await host.ready();
    passed(report, '单宿主空部署默认免令牌');
  });
  await stage(report, '实际原 TGZ 上传、加载与有效预算目录', async () => {
    await installFixtures(host, items, directory, report);
    passed(report, '协议2/3在线原包与HTTP/MCP有效预算');
  });
  await verifyMatrix(host, items, report);
  await stage(report, '宿主原10秒正常关闭与监听释放', async () => {
    await host.shutdown();
    assert.deepEqual(host.entry.exit && { code: host.entry.exit.code, signal: host.entry.exit.signal },
      { code: 0, signal: null });
    passed(report, '宿主正常exit0与监听释放');
  });
  await stage(report, '退出后原包/宿主身份和日志关联', async () => {
    await host.verifyIdentity();
    await verifyPackageBytes(report);
    await verifyLogs(host.directory, host, report);
    passed(report, '8 Job/request/提交logID配对及全部响应ID落盘');
  });
  completed = true;
} catch (error) {
  recordFailure(report, error);
  process.exitCode = 1;
} finally {
  // 清理失败不能掩盖业务首失败；只操作本次持有的直接宿主 ChildProcess。
  if (host) {
    try { await host.finish(); }
    catch (error) {
      recordFailure(report, error);
      report.cleanup_error = { name: error.name, code: error.code };
      completed = false;
      process.exitCode = 1;
    }
    if (!completed) {
      await collectKnownProcesses(items, report);
      try {
        await host.verifyIdentity();
        if (report.packages?.length) await verifyPackageBytes(report);
      } catch (error) { report.failure_identity_error = { name: error.name, code: error.code }; }
    }
  }
  report.passed = completed && report.failure_stage === undefined;
  if (directory) {
    try { await retainEvidence(directory, items, report); }
    catch (error) {
      recordFailure(report, error);
      report.retention_error = { name: error.name, code: error.code };
      process.exitCode = 1;
    }
  }
  report.stage = report.passed ? '完成' : report.stage;
  const path = await writeReport(root, report);
  console.log(JSON.stringify({ passed: report.passed, profile, report: path,
    jobs: report.jobs.length, failure_stage: report.failure_stage,
    error_name: report.error?.name, temporary_retained: report.temporary_retained }));
  if (!report.passed) process.exitCode = 1;
}
