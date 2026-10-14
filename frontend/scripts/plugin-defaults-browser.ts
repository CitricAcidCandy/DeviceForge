import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createDefaultsBrowser, listenerReleased } from './plugin-defaults-browser/browser.ts';
import { createDefaultsFixture, pluginIds } from './plugin-defaults-browser/fixture.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const frontend = fileURLToPath(new URL('../', import.meta.url));
const project = resolve(frontend, '..');
const run = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = join(project, 'artifacts', 'plugin-defaults', run);
const bundle = join(output, 'bundle');
const profile = join(output, 'browser-profile');
const browserEvidence: Record<string, unknown> = { socket_events: [], stages: [] };
const fixture = createDefaultsFixture();
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(), output, passed: false,
  scope: '真实 main/startFrontendApp、HTTP 受控安装/运行目录、原生 ESM SDK v2；不含真实 Rust 插件进程、真机或性能。正式 Vite/Rust 设备页仅只读截图。',
  browser: browserEvidence,
};
let browser: Awaited<ReturnType<typeof createDefaultsBrowser>> | null = null;
let port = 0;
const server = await createServer({
  root: bundle, configFile: false, appType: 'custom', logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
await mkdir(output, { recursive: true });

try {
  const sourceFiles = [
    'src/app/main.ts', 'src/app/product/services.ts', 'src/app/installed-package-importer.ts',
    'src/features/plugin-defaults/models/plugin-defaults.ts', 'src/pages/plugins/index.tsx',
  ];
  report['source_inputs'] = await Promise.all(sourceFiles.map(async (path) => {
    const bytes = await readFile(join(frontend, path));
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  await build({
    root: frontend, configFile: false, logLevel: 'warn', plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(frontend, 'src') } },
    build: {
      outDir: bundle, emptyOutDir: false,
      rolldownOptions: {
        input: {
          harness: join(frontend, 'scripts/plugin-defaults-browser/harness.ts'),
          success: join(frontend, 'scripts/plugin-defaults-browser/success.ts'),
          failure: join(frontend, 'scripts/plugin-defaults-browser/failure.ts'),
        },
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'assets/[name].js' },
      },
    },
  });
  const names = await readdir(join(bundle, 'assets'));
  const assets = new Map<string, Buffer>();
  report['build_inputs'] = await Promise.all(names.map(async (name) => {
    const bytes = await readFile(join(bundle, 'assets', name));
    assets.set(name, bytes);
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  server.middlewares.use((request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__plugin_defaults__') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const styles = names.filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="/assets/${name}">`).join('');
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>默认启用浏览器验收</title>${styles}<body><script>window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));const original=console.error;console.error=(...args)=>{window.__errors.push(args.map(String).join(' '));original(...args);};</script><script type="module">import * as harness from '/assets/harness.js';window.__harness=harness;await harness.mount();window.__mounted=true;</script></body></html>`);
      return;
    }
    if (url.pathname === '/__defaults_evidence__') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(fixture.snapshot()));
      return;
    }
    const native = url.pathname.match(/^\/api\/v2\/browser-plugins\/([^/]+)\/runs\/([^/]+)\/assets\/(.+)$/);
    if (native) {
      const id = native[1] ?? '';
      const runId = native[2] ?? '';
      const path = native[3] ?? '';
      fixture.assets.push({ id, run: runId, path });
      const entry = path === 'dist/index.js'
        ? id === pluginIds.success ? 'success.js' : id === pluginIds.failure ? 'failure.js' : ''
        : basename(path);
      const bytes = assets.get(entry);
      if (bytes) {
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.end(bytes);
      } else { response.statusCode = 404; response.end('资源不存在'); }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const result = fixture.handle(url.pathname + url.search, request.method ?? 'GET');
      response.statusCode = result.status;
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-deviceforge-log-id', 'plugin-defaults-http-log');
      response.end(JSON.stringify(result.status < 400
        ? { log_id: 'plugin-defaults-http-log', data: result.data }
        : { log_id: 'plugin-defaults-http-log', error: { code: 'not_found', message: '受控路由不存在' } }));
      return;
    }
    next();
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  port = address.port;
  const base = `http://127.0.0.1:${port}`;
  report['base'] = base;
  browser = await createDefaultsBrowser(project, profile, browserEvidence);
  await browser.navigate(base + '/__plugin_defaults__#plugins');
  await browser.wait('window.__mounted===true', '真实 main 入口');
  const result = await browser.evaluate('window.__harness.verify()');
  report['behavior'] = result;
  assert.ok(object(result) && result['passed'] === true, '默认启动浏览器检查失败');
  report['console_errors'] = await browser.evaluate('window.__errors');
  assert.deepEqual(report['console_errors'], [], '默认启动控制台发生错误');
  await browser.capture(join(output, 'plugin-defaults-desktop.png'), 1536, 1024);
  report['app_cleanup'] = await browser.evaluate('window.__harness.dispose()');
  report['http_evidence'] = fixture.snapshot();

  // 正式产品页面只读：不点发现、连接、能力或任务按钮。
  if (process.argv.includes('--live-devices')) {
    await browser.navigate('http://127.0.0.1:5173/#devices');
    await browser.wait('document.querySelector("[data-route=devices]")&&document.body.textContent.includes("服务器已连接")', '正式设备页');
    await browser.capture(join(output, 'live-devices-desktop.png'), 1536, 1024);
    report['live_devices'] = await browser.evaluate('({url:location.href,text:document.body.innerText,width:innerWidth,bodyWidth:document.documentElement.scrollWidth})');
  }
  report['passed'] = true;
} catch (error) {
  report['error'] = error instanceof Error ? error.message : String(error);
  report['failure_page'] = await browser?.evaluate('({url:location.href,text:document.body.innerText,errors:window.__errors})').catch(() => null);
  await browser?.capture(join(output, 'failure.png'), 1536, 1024).catch(() => {});
} finally {
  await browser?.evaluate('window.__harness?.dispose()').catch((error: unknown) => {
    report['cleanup_error'] = error instanceof Error ? error.message : String(error);
  });
  await browser?.close();
  const listener = server.httpServer;
  if (listener && 'closeAllConnections' in listener) listener.closeAllConnections();
  await server.close();
  report['http_listener'] = { port, released: port ? await listenerReleased(port) : true };
  const relativeProfile = relative(output, profile);
  assert.ok(profile.startsWith(output + sep) && !relativeProfile.startsWith('..') && basename(profile) === 'browser-profile');
  await rm(profile, { recursive: true, force: true });
  report['profile_cleaned'] = true;
  report['completed_at'] = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (report['passed'] !== true) process.exitCode = 1;
  console.log(`默认启用浏览器验收：${report['passed'] === true ? '通过' : '未通过'}；证据：${output}`);
}
