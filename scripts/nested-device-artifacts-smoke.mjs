import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './nested-device-artifacts/fixtures.mjs';
import { prepareHost } from './nested-device-artifacts/host.mjs';
import { verifyNestedDeviceArtifacts } from './nested-device-artifacts/suite.mjs';

// 只消费集成负责人已构建的宿主；不运行 Cargo/npm 或修改部署工作区。
const root = fileURLToPath(new URL('../', import.meta.url));
const arguments_ = process.argv.slice(2);
assert.ok(
  arguments_.every((value) => value === '--release'),
  '只支持 --release 参数',
);
const profile = arguments_.includes('--release') ? 'release' : 'debug';
const reportPath = resolve(root, 'artifacts', `nested-device-artifacts-smoke-${profile}.json`);
const report = {
  timestamp: new Date().toISOString(),
  profile,
  platform: process.platform,
  architecture: process.arch,
  scope:
    '本机默认免鉴权真实 Rust HTTP/MCP，协议 2/3 synthetic_demo 设备提供者在线 TGZ、嵌套输入副本和 JSON 输出原字节、精确失败、取消与热装卸；不含真机、常驻连接、系统隔离、浏览器 UI 或 npx 分发',
  passed: false,
  stage: '检查当前构建',
  checks: [],
};
const fixtures = [];
let host;

try {
  host = await prepareHost(root, profile, report);
  for (const protocol of [2, 3])
    fixtures.push(await fixture(protocol, join(host.temporary, 'markers')));
  await host.start();
  await verifyNestedDeviceArtifacts({ host, fixtures, report });
  report.server_restarted = false;
  report.stage = '正常关闭与日志落盘';
  await host.shutdown();
  await host.verifyLogs();
  report.checks.push({ name: '宿主 10 秒内正常退出、响应日志关联落盘', passed: true });
  report.stage = '完成';
  report.passed = true;
} catch (error) {
  // 保留第一个失败请求的路径/状态/日志 ID；不输出请求正文、凭据或任意插件载荷。
  if (report.last_request) report.failed_request ??= { ...report.last_request };
  report.error = String(error.message).split('\n')[0].slice(0, 500);
  report.error_name = error.name;
  report.error_location = String(error.stack)
    .split('\n')
    .filter((line) => line.includes('nested-device-artifacts'))
    .slice(0, 4);
  process.exitCode = 1;
} finally {
  try {
    if (host) await host.finish(fixtures);
  } catch (error) {
    report.passed = false;
    report.cleanup_error = String(error.message).split('\n')[0].slice(0, 500);
    process.exitCode = 1;
  }
  report.completed_at = new Date().toISOString();
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify({
      passed: report.passed,
      stage: report.stage,
      report: reportPath,
      error: report.error,
      temporary_retained: report.temporary_retained,
    }),
  );
}
