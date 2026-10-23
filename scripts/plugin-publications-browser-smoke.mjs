// 网页上传完整ZIP的真实验收入口；只使用已冻结产物，不构建、不操作现有预览或设备。
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPublicationBrowser } from './plugin-publications-browser-smoke/browser.mjs';
import { launch, fileIdentity } from './plugin-installations-smoke/host.mjs';
import { launchMarket } from './plugin-installations-smoke/market.mjs';
import { launchProductBridge } from './plugin-installations-browser-smoke/bridge.mjs';
import { publicationSmokeOptions } from './plugin-publications-browser-smoke/options.mjs';
import { publicationFixtures } from './plugin-publications-browser-smoke/fixtures.mjs';
import { launchPublicationGateway } from './plugin-publications-browser-smoke/gateway.mjs';
import { cleanupTemporary, listenerReleased, reclaimOwnedBrowserProcesses, verifyFrozenDist, verifyPublicationEvidence } from './plugin-publications-browser-smoke/verification.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = publicationSmokeOptions(root, process.argv.slice(2));
await mkdir(join(root, 'artifacts'), { recursive: true });
const directory = await mkdtemp(join(root, 'artifacts', `plugin-publications-browser-${options.profile}-`));
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-publications-browser-'));
const profile = join(temporary, 'edge-profile');
const report = {
  started_at: new Date().toISOString(), passed: false, directory, temporary,
  profile: options.profile, binary_directory: options.binaryDirectory, market_binary_directory: options.marketDirectory,
  dist_directory: options.dist,
  browser_profile_directory: profile, binaries: [], hosts: [], requests: [],
  checks: { dom: null, network: null, visual_review: '等待逐张图片审核' },
  entrypoint_process: { pid: process.pid, executable: process.execPath, arguments: process.argv.slice(1) },
  scope: '独占回环端口和用户根、真实Rust市场能力与宿主、当前生产dist、网页完整ZIP拆分发布与资源共享去重、成套安装配置和公开SDK；DOM、网络与图片审核分别留证；不含十八官方插件、移动端、真机、第二物理客户端或npx',
};
let market, host, gateway, bridge;
const ports = new Set();
const remember = (base) => ports.add(Number(new URL(base).port));
try {
  report.stage = '启动任何服务前核对冻结输入';
  for (const path of [options.binary, options.marketBinary, join(options.dist, 'index.html'), join(options.dist, 'assets/app.js')]) {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `冻结输入必须为现有普通文件：${path}`);
  }
  report.binaries = await Promise.all([options.binary, options.marketBinary].map(fileIdentity));
  report.stage = '生成小型实际第三方完整ZIP及共享组件发布';
  await mkdir(join(directory, 'fixtures'));
  const fixtures = await publicationFixtures(join(directory, 'fixtures'));
  report.fixtures = Object.fromEntries(await Promise.all(Object.entries(fixtures).map(async ([key, fixture]) => [key, {
    id: fixture.id, version: fixture.version, name: fixture.name, archive: await fileIdentity(fixture.archive),
    components: fixture.manifest.components.map((item) => ({ id: item.id, version: item.version, kind: item.kind })),
    resources: [...fixture.manifest.components, ...fixture.manifest.tools].flatMap((item) => item.variants),
  }])));
  report.stage = '启动本轮真实Rust市场与受控故障网关';
  market = await launchMarket({ binary: options.marketBinary, cwd: root, data: join(temporary, 'market'), report });
  assert.deepEqual(report.market.binary, report.binaries[1], '启动的市场必须保持预检冻结身份');
  remember(market.base); ports.add(report.market.port);
  gateway = await launchPublicationGateway({ market, fixtures, report }); remember(gateway.base);
  const capabilities = await fetch(`${gateway.base}/api/v1/capabilities`, { signal: AbortSignal.timeout(3000) });
  assert.equal(capabilities.status, 200, '必须使用具备真实能力接口的新市场二进制');
  report.capabilities = await capabilities.json();
  assert.equal(report.capabilities.api_version, 1);
  assert.equal(report.capabilities.release_publication.catalog_last, true);

  report.stage = '启动本轮真实隔离宿主及生产前端桥接';
  host = await launch({ binary: options.binary, cwd: root, data: join(temporary, 'data'),
    user: join(temporary, 'user'), market: gateway.base, report });
  assert.deepEqual(report.hosts.at(-1).binary, report.binaries[0], '启动的宿主必须保持预检冻结身份');
  remember(host.base);
  bridge = await launchProductBridge({ dist: options.dist, host, market: gateway,
    profile, directory, report, publishUpdate: async () => { throw new Error('本轮必须通过产品网页发布，禁止服务端代发'); } });
  remember(bridge.origin);
  report.stage = '真实产品网页发布流程';
  const module = `${gateway.base}/__publication/scenarios.mjs`;
  const expression = `(async()=>{const module=await import(${JSON.stringify(module)});return module.verifyProductPublications(${JSON.stringify({ gateway: gateway.base })});})()`;
  report.browser = await runPublicationBrowser(`${bridge.origin}/#settings`, expression, profile, report);
  assert.equal(report.browser?.passed, true, report.browser?.error?.message ?? '网页发布DOM验收未通过');
  report.stage = '独立核对真实市场网络和最终目录';
  report.checks.network = false;
  report.network_assertions = await verifyPublicationEvidence({ gateway, market, fixtures, report });
  report.checks.dom = true; report.checks.network = true; report.checks.visual_review = '等待逐张图片审核';
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  for (const [name, service] of [['bridge', bridge], ['host', host], ['gateway', gateway], ['market', market]]) {
    if (!service) continue;
    try { await service.stop(); }
    catch (error) { report[`${name}_shutdown_error`] = error.message; report.passed = false; process.exitCode = 1; }
  }
  for (const entry of report.hosts) ports.add(entry.port);
  if (report.market?.port) ports.add(report.market.port);
  try {
    const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
    const debugPort = Number(active.split('\n')[0]);
    if (Number.isInteger(debugPort) && debugPort > 0) ports.add(debugPort);
  } catch { /* 浏览器启动前失败时没有调试端口文件。 */ }
  try {
    report.owned_browser_processes_after = report.browser_process
      ? await reclaimOwnedBrowserProcesses(profile, report) : { skipped: '未启动浏览器', processes: [] };
    if (report.browser_recovery?.length) { report.passed = false; process.exitCode = 1; }
    if (report.owned_browser_processes_after.processes.length) {
      report.passed = false; process.exitCode = 1;
      report.process_cleanup_error = '本轮独占浏览器配置仍有进程存活，须按已登记PID收回后再交付';
    }
  } catch (error) {
    report.process_cleanup_error = error.message; report.passed = false; process.exitCode = 1;
  }
  report.listeners = await Promise.all([...ports].map(async (port) => ({ port, released: await listenerReleased(port) })));
  if (report.listeners.some((item) => !item.released)) { report.passed = false; process.exitCode = 1; }
  report.binary_recheck = await Promise.all(report.binaries.map(async (previous) => {
    try {
      const current = await fileIdentity(previous.path);
      return { ...current, unchanged: current.size === previous.size && current.sha256 === previous.sha256 };
    } catch (error) { return { path: previous.path, unchanged: false, error: error.message }; }
  }));
  if (report.binary_recheck.some((item) => !item.unchanged)) { report.passed = false; process.exitCode = 1; }
  if (report.production_inputs?.length) {
    try { report.frozen_dist_recheck = await verifyFrozenDist(report); }
    catch (error) { report.dist_recheck_error = error.message; report.passed = false; process.exitCode = 1; }
  }
  report.temporary_removed = false;
  if (report.passed) {
    try { await cleanupTemporary(temporary); report.temporary_removed = true; }
    catch (error) { report.temporary_cleanup_error = error.message; report.passed = false; process.exitCode = 1; }
  } else report.temporary_retained_reason = '保留本轮失败数据供审计，不删除失败原件';
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(directory, 'visual-review.md'),
    '# 网页完整功能发布截图待审核\n\n逐张实际打开图片，审核预览、旧市场拒绝、错误重试、取消、资源复用、发布完成、发现安装与中文配置。DOM和网络通过不替代图片审核；不扩大为十八官方、移动端或真机。\n\n' +
    (report.screenshots ?? []).map((item) => `- ${item.path}`).join('\n') + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, profile: report.profile, stage: report.stage,
    report: join(directory, 'report.json'), screenshots: report.screenshots, error: report.error }, null, 2));
}
