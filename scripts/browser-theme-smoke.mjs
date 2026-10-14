import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { themeFixtures } from './browser-theme-smoke/fixtures.mjs';
import { runBrowser } from './browser-theme-smoke/driver.mjs';
import { themeArguments, themeInputs } from './browser-theme-smoke/inputs.mjs';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { retainTheme } from './browser-theme-smoke/evidence.mjs';
import { mountBuiltBrowserAssets } from './browser-built-assets.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { bounded } from './unified-discovery-browser/lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = themeArguments(process.argv.slice(2));
const { profile } = options;
let binary;
let assetsDirectory;
let frozenInputs;
const report = {
  timestamp: new Date().toISOString(),
  run_id: randomUUID(),
  profile,
  passed: false,
  requests: [],
  checks: [],
  jobs: [],
  scope:
    '真实浏览器在线主题包、公开ThemeAccess、owner-generation、样式基线恢复与激活失败回滚；不含产品UI视觉、真机或生产容量',
};
let hostPath;
let harnessPath;
const inputPaths = [
  fileURLToPath(import.meta.url),
  resolve(root, 'scripts/browser-theme-smoke/fixtures.mjs'),
  resolve(root, 'scripts/browser-theme-smoke/driver.mjs'),
  resolve(root, 'scripts/browser-theme-smoke/cdp.mjs'),
  resolve(root, 'scripts/browser-theme-smoke/inputs.mjs'),
  resolve(root, 'scripts/browser-theme-smoke/evidence.mjs'),
  resolve(root, 'scripts/browser-built-assets.mjs'),
  resolve(root, 'frontend/scripts/browser-theme-harness.ts'),
];
let host;
let vite;
let temporary;
let builtAssets;
async function closeProxy() {
  if (!vite) return;
  const current = vite;
  vite = undefined;
  current.httpServer?.closeAllConnections();
  await bounded(current.close(), 5000, '本次主题验收代理关闭超时');
}
try {
  report.stage = '冻结输入';
  frozenInputs = await themeInputs(root, options);
  ({ binary, assetsDirectory } = frozenInputs);
  hostPath = join(assetsDirectory, 'plugin-host.js');
  harnessPath = join(assetsDirectory, 'browser-theme-harness.js');
  inputPaths.push(binary, ...frozenInputs.extraPaths.filter((path) => path !== binary));
  report.input_mode = frozenInputs.manifestPath ?? '当前构建目录';
  report.driver_pid = process.pid;
  report.browser_launch_mode = options.inProcessGpu
    ? 'headless进程内GPU；仅功能资格，不含GPU或性能验收'
    : '原默认headless参数';
  report.browser_process = {};
  report.inputs_before = await Promise.all(inputPaths.map(fileIdentity));
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-theme-'));
  report.temporary_root = temporary;
  report.stage = '启动自有空宿主';
  host = await prepareHost({
    root,
    binary,
    directory: join(temporary, 'data'),
    report,
    port: await reservePort(),
  });
  await host.ready();
  host.assertRunning();
  const fixtures = themeFixtures();
  report.fixtures = Object.fromEntries(
    Object.entries(fixtures).map(([kind, fixture]) => [
      kind,
      {
        id: fixture.id,
        archive_bytes: fixture.archive.length,
        archive_sha256: createHash('sha256').update(fixture.archive).digest('hex'),
      },
    ]),
  );
  for (const [kind, fixture] of Object.entries(fixtures))
    await writeFile(join(temporary, kind + '.tgz'), fixture.archive, { flag: 'wx' });
  vite = await createServer({
    root: resolve(root, 'frontend'),
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': host.client.base } },
  });
  builtAssets = await mountBuiltBrowserAssets(vite, assetsDirectory);
  report.built_assets = builtAssets.inputs;
  const productionHost = await readFile(hostPath);
  report.harness = await fileIdentity(harnessPath);
  report.host = await fileIdentity(hostPath);
  vite.middlewares.use('/__production_host__', (_request, response) => {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(productionHost);
  });
  for (const [kind, fixture] of Object.entries(fixtures))
    vite.middlewares.use(`/__fixture__/${kind}.tgz`, (_request, response) => {
      response.setHeader('content-type', 'application/gzip');
      response.end(fixture.archive);
    });
  vite.middlewares.use('/__theme_verification__', (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>主题插件行为验收</title><body></body></html>',
    );
  });
  await vite.listen();
  const address = vite.httpServer.address();
  report.stage = '真实浏览器主题行为';
  report.browser = await runBrowser(
    `http://127.0.0.1:${address.port}/__theme_verification__`,
    `(async()=>{ const harness=await import('/assets/browser-theme-harness.js'); return await harness.verifyThemes(); })()`,
    join(temporary, 'browser-profile'),
    (runtime) => {
      report.browser_runtime = runtime;
    },
    { evidence: report.browser_process, inProcessGpu: options.inProcessGpu },
  );
  assert.equal(report.browser.passed, true);
  assert.ok(report.browser.checks.length >= 8);
  assert.ok(report.browser.checks.every((check) => check.passed === true));
  report.stage = '正常退出与输入复核';
  await closeProxy();
  await host.shutdown();
  await host.verifyIdentity();
  await builtAssets.verify();
  report.stage = '完成';
  report.passed = true;
} catch (error) {
  report.failure_stage = report.stage;
  report.error = { name: error.name, message: String(error.message).slice(0, 600) };
  report.passed = false;
  process.exitCode = 1;
} finally {
  try {
    await closeProxy();
  } catch (error) {
    report.proxy_cleanup_error = { name: error.name };
    report.passed = false;
    process.exitCode = 1;
  }
  if (host)
    try {
      await host.finish();
    } catch (error) {
      report.host_cleanup_error = { name: error.name };
      report.passed = false;
      process.exitCode = 1;
    }
  if (builtAssets)
    try {
      await builtAssets.verify();
    } catch (error) {
      report.built_assets_error = { name: error.name };
      report.passed = false;
      process.exitCode = 1;
    }
  if (report.inputs_before)
    try {
      report.inputs_after = await Promise.all(inputPaths.map(fileIdentity));
      report.inputs_stable =
        JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      assert.equal(report.inputs_stable, true, '冻结输入前后须原字节稳定');
    } catch (error) {
      report.input_check_error = { name: error.name };
      report.passed = false;
      process.exitCode = 1;
    }
  if (temporary)
    try {
      await retainTheme(temporary, report);
    } catch (error) {
      report.retention_error = { name: error.name };
      report.temporary_retained = temporary;
      report.passed = false;
      process.exitCode = 1;
    }
  report.completed_at = new Date().toISOString();
  const directory = resolve(root, 'artifacts', `browser-theme-smoke-${profile}-${report.run_id}`);
  await mkdir(directory, { recursive: true });
  report.report_path = join(directory, 'report.json');
  await writeFile(report.report_path, JSON.stringify(report, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
}
console.log(
  JSON.stringify({
    passed: report.passed,
    report: report.report_path,
    stage: report.failure_stage ?? report.stage,
    error: report.error,
  }),
);
