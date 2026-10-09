import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { serverFixture } from '../backend/scripts/online-plugins/fixtures.mjs';
import { browserRuntimeFixture, deviceProviderFixture } from './browser-plugin-fixture.mjs';
import { runBrowser } from './browser-driver.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.slice(2).every(value => value === '--release'), '仅支持 --release');
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend/target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-browser-'));
const reportPath = resolve(root, 'artifacts', `browser-plugin-smoke-${profile}.json`);
const report = { timestamp: new Date().toISOString(), profile, platform: process.platform,
  host: 'frontend/dist/assets/plugin-host.js',
  scope: '本机真实 Rust 在线安装、生产宿主 ESM 与相对依赖、开放扩展、公开设备能力/提供者热装卸与旧代引用拒绝；独立验收页面，不含产品视觉、真机和生产容量', passed: false };
let child; let closed; let vite; let graceful = false;
async function closeProxy() {
  if (!vite) return;
  const current = vite; vite = undefined;
  // 验收浏览器已关闭，撤销本次代理连接后再核对 Rust 的正常退出。
  current.httpServer?.closeAllConnections();
  await Promise.race([current.close(), delay(5000).then(() => { throw new Error('验收代理关闭超时'); })]);
}
async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  assert.ok(response.ok, `真实服务请求失败 ${response.status} ${path}: ${body.error?.code}`);
  assert.equal(body.log_id, response.headers.get('x-deviceforge-log-id'));
  return body.data;
}
async function ready(base) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('真实 Rust 服务提前退出');
    try { await call(base, '/api/v2/operations'); return; } catch {}
    await delay(50);
  }
  throw new Error('真实 Rust 服务未就绪');
}

try {
  report.stage = '启动真实宿主';
  const port = await reservePort(); const base = `http://127.0.0.1:${port}`;
  child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, APK_API_TOKEN: '', APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: join(temporary, 'data'),
    APK_PLUGIN_DIR: join(temporary, 'server-plugins'), APK_BROWSER_PLUGIN_DIR: join(temporary, 'browser-plugins'),
    DEVICEFORGE_NODE: process.execPath,
  } });
  let diagnostic = '';
  child.stdout.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-65536); });
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-65536); });
  closed = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  await ready(base);
  const server = serverFixture(2); const browser = browserRuntimeFixture(); const device = await deviceProviderFixture();
  vite = await createServer({ root: resolve(root, 'frontend'), configFile: false, appType: 'custom', logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': base } } });
  const hostModule = await readFile(resolve(root, 'frontend/dist/assets/plugin-host.js'));
  vite.middlewares.use('/__production_host__', (_request, response) => {
    response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(hostModule);
  });
  const harnessModule = await readFile(resolve(root, 'frontend/scripts/browser-plugin-harness.mjs'));
  vite.middlewares.use('/__harness__', (_request, response) => {
    response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(harnessModule);
  });
  vite.middlewares.use('/__plugin_verification__', (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>插件行为验收</title><body></body></html>');
  });
  for (const [kind, fixture] of [['server', server], ['browser', browser], ['device', device]]) {
    vite.middlewares.use(`/__fixture__/${kind}.tgz`, (_request, response) => {
      response.setHeader('content-type', 'application/gzip'); response.end(fixture.archive);
    });
  }
  await vite.listen();
  const address = vite.httpServer.address();
  const page = `http://127.0.0.1:${address.port}/__plugin_verification__`;
  const expression = `(async () => {
    const deadline=Date.now()+5000;
    while(location.pathname!=='/__plugin_verification__'||document.readyState==='loading') {
      if(Date.now()>deadline) throw new Error('浏览器验收页面未就绪');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const harness=await import('/__harness__');
    return harness.verifyInstalledPlugin();
  })()`;
  report.stage = '生产浏览器行为';
  report.browser = await runBrowser(page, expression, join(temporary, 'browser-profile'));
  assert.equal(report.browser.passed, true);
  for (const [kind, id] of [['server', server.id], ['browser', browser.id]]) {
    assert.deepEqual(await call(base, `/api/v2/plugin-packages/${kind}`), []);
  }
  report.stage = '关闭验收代理';
  await closeProxy();
  report.stage = 'Rust 正常退出';
  await call(base, '/api/v2/system/shutdown', { method: 'POST' });
  const exit = await Promise.race([closed, delay(10000).then(() => { throw new Error('Rust 服务退出超时'); })]);
  assert.deepEqual(exit, { code: 0, signal: null }); graceful = true;
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (child && !graceful && child.exitCode === null && child.signalCode === null) {
    child.kill(); await Promise.race([closed.catch(() => undefined), delay(5000)]);
  }
  try { await closeProxy(); }
  catch (error) { report.proxyCleanupError = error.message; report.passed = false; process.exitCode = 1; }
  const within = relative(tmpdir(), temporary);
  assert.ok(within && !isAbsolute(within) && !within.startsWith('..'), '临时清理必须位于本次临时根');
  try {
    if (report.passed) await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    else report.temporaryRetained = temporary;
  }
  catch (error) { report.cleanupError = error.code; report.passed = false; process.exitCode = 1; }
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ passed: report.passed, report: reportPath, error: report.error }));
