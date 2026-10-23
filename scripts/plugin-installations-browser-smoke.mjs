// 从真实产品市场操作第三方完整发布；不构建、不连接用户端口或在线设备。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowser } from './browser-driver.mjs';
import { launch } from './plugin-installations-smoke/host.mjs';
import { launchMarket } from './plugin-installations-smoke/market.mjs';
import { publish, stageEvents, persistedConfiguration } from './plugin-installations-smoke/scenarios.mjs';
import { browserReleaseFixture } from './plugin-installations-browser-smoke/fixtures.mjs';
import { launchProductBridge } from './plugin-installations-browser-smoke/bridge.mjs';
import { browserSmokeOptions } from './plugin-installations-browser-smoke/options.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = browserSmokeOptions(root, process.argv.slice(2));
const output = join(root, 'artifacts'); await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, `plugin-installations-browser-${options.profile}-`));
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-installations-browser-'));
const { binary, marketBinary } = options;
const profile = join(temporary, 'edge-profile');
const report = { started_at: new Date().toISOString(), passed: false, directory, temporary,
  profile: options.profile, binary_directory: options.binaryDirectory, market_binary_directory: options.marketDirectory,
  browser_profile_directory: profile, binaries: [], hosts: [], requests: [], checks: {},
  scope: `独占端口和用户根、当前生产前端、真实${options.profile} Rust宿主和市场、第三方完整发布的产品安装配置启停卸载重试；不含设备业务、视觉审核结论或npx验收` };
let market, host, bridge;
try {
  const lan = Object.entries(networkInterfaces()).flatMap(([name, values]) =>
    (values ?? []).filter((value) => value.family === 'IPv4' && !value.internal && !value.address.startsWith('169.254.'))
      .map((value) => ({ name, address: value.address })))[0];
  report.local_lan = lan ? { ...lan, scope: '本机浏览器通过真实局域网IPv4访问；不是第二台物理客户端' }
    : { skipped: true, reason: '当前主机没有可用的非回环IPv4；仅执行回环浏览器流程' };
  report.stage = '启动真实隔离市场';
  market = await launchMarket({ binary: marketBinary, cwd: root, data: join(temporary, 'market'), report });
  report.binaries.push(report.market.binary);
  const first = await browserReleaseFixture(temporary);
  const update = await browserReleaseFixture(temporary, { version: '1.1.0', toolVersion: '2.0.0', toolBytes: '第二版本工具' });
  await publish(first, market);
  report.stage = '启动真实隔离宿主';
  host = await launch({ binary, cwd: root, data: join(temporary, 'data'), user: join(temporary, 'user'), market: market.base, report,
    ...(lan ? { bindAddress: '0.0.0.0' } : {}) });
  report.binaries.push(report.hosts.at(-1).binary);
  if (lan) report.local_lan.server_origin = `http://${lan.address}:${new URL(host.base).port}`;
  bridge = await launchProductBridge({ dist: join(root, 'frontend/dist'),
    host: lan ? { ...host, base: report.local_lan.server_origin } : host, market, profile, directory, report,
    ...(lan ? { bindAddress: '0.0.0.0', publicAddress: lan.address } : {}),
    publishUpdate: () => publish(update, market) });
  report.stage = '真实产品浏览器';
  report.browser = await runBrowser(`${bridge.origin}/#settings`,
    '(async () => (await import("/__smoke/scenarios.mjs")).verifyProductInstallations())()', profile,
    (runtime) => { report.browser_runtime = runtime; });
  assert.equal(report.browser.passed, true, report.browser.error?.message ?? '真实产品浏览器未通过');
  const install = report.product_proxy.find((entry) => entry.method === 'POST' && entry.path === '/api/v2/plugin-installations');
  assert.equal(install?.status, 202);
  const submitted = (await host.call('/api/v2/jobs?limit=100')).find((job) => job.operation === 'installation.install');
  assert.ok(submitted); report.checks.stage_events = await stageEvents(host, submitted.id);
  assert.ok(report.product_proxy.some((entry) => entry.status === 409 && entry.plugin_release));
  assert.ok(report.browser_network.some((entry) => entry.plugin_release && entry.status === 202));
  assert.equal(report.bridge_errors?.length ?? 0, 0);
  assert.equal(report.browser_console.some((entry) => entry.kind === 'exception'), false, '不得存在未处理浏览器异常');
  if (lan) {
    assert.equal(report.browser.local_lan?.component_status, 200, '浏览器须通过真实LAN地址直接读取宿主组件');
    assert.ok(report.browser_network.some((entry) => entry.origin === report.local_lan.server_origin &&
      entry.path.includes('/plugin-installations/browser/') && entry.method === 'GET' && entry.status === 200));
  }
  const componentRequests = report.browser_network.filter((entry) => entry.path.includes('/plugin-installations/browser/'));
  assert.ok(componentRequests.length > 0 && componentRequests.every((entry) => entry.method === 'GET'));
  assert.equal(report.browser_network.some((entry) => /\/blobs\/|\/tools\/|\.exe$|\/tool\.bin$/.test(entry.path)), false,
    '工具由服务器安装并绑定，浏览器不下载可执行工具');
  report.checks.browser_gets_components_tools_remain_server_bound = true;
  await persistedConfiguration(join(temporary, 'user'), first);
  report.checks.uninstall_preserves_user_configuration = true;
  report.checks.product_flow = true;
  report.passed = true;
} catch (error) { report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  for (const [name, service] of [['bridge', bridge], ['host', host], ['market', market]]) {
    if (!service) continue;
    try { await service.stop(); } catch (error) { report[`${name}_shutdown_error`] = error.message; report.passed = false; process.exitCode = 1; }
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(directory, 'visual-review.md'), '# 真实产品插件安装截图待审核\n\n请 director_visual 审核中文名称与描述、配置表单、失败与重试入口、启停状态及卸载结果，记录遮挡、裁切、对齐、可读性和交互状态问题。主代理未读取图片。\n\n' + (report.screenshots ?? []).map((item) => `- ${item.path}`).join('\n') + '\n');
  console.log(JSON.stringify({ passed: report.passed, profile: report.profile, stage: report.stage,
    report: join(directory, 'report.json'), screenshots: report.screenshots, error: report.error }, null, 2));
}
