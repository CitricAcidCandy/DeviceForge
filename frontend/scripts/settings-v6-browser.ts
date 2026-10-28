import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createDefaultsBrowser, listenerReleased } from './plugin-defaults-browser/browser.ts';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const project = resolve(frontend, '..');
const run = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = join(project, 'artifacts', 'settings-v6-20261027', run);
const bundle = join(output, 'bundle');
const profile = join(output, 'browser-profile');
const evidence: Record<string, unknown> = { socket_events: [] };
const report: Record<string, unknown> = {
  started_at: new Date().toISOString(), output, passed: false, browser_process: evidence,
  driver_pid: process.pid,
  scope: '真实 App 与设置页、受控 ProductServices 回调和空设备目录；不连接设备，不改用户服务，不代表真实 Rust 服务联调',
};
const captures: { name: string; path: string; width: number; height: number }[] = [];
report['captures'] = captures;
const execute = promisify(execFile);
let browser: Awaited<ReturnType<typeof createDefaultsBrowser>> | null = null;
const server = await createServer({
  root: bundle, configFile: false, appType: 'custom', logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
let port = 0;
let stage = '准备独占产物';
let browserClosed = false;
let sourceHashes: { path: string; size: number; sha256: string }[] = [];
await mkdir(output, { recursive: true });
try {
  async function pageInputs(directory: string): Promise<string[]> {
    const entries = await readdir(join(frontend, directory), { withFileTypes: true });
    const groups = await Promise.all(entries.map((entry) => entry.isDirectory()
      ? pageInputs(directory + '/' + entry.name)
      : Promise.resolve([directory + '/' + entry.name])));
    return groups.flat();
  }
  const inputs = [
    ...await pageInputs('src/pages/settings'), 'src/app/product/App.tsx', 'src/app/product/shell.tsx',
    'src/app/product/hooks.ts', 'src/app/product/error-feedback.ts', 'src/app/product/layout.css', 'src/app/styles.css',
    'scripts/settings-v6-fixture.ts', 'scripts/settings-v6-browser-harness.ts',
    'scripts/settings-v6-browser.ts', 'scripts/plugin-defaults-browser/browser.ts',
  ];
  sourceHashes = await Promise.all(inputs.map(async (path) => {
    const bytes = await readFile(join(frontend, path));
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  report['source_inputs'] = sourceHashes;
  await build({
    root: frontend, configFile: false, logLevel: 'warn', plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(frontend, 'src') } },
    build: {
      outDir: bundle, emptyOutDir: false,
      rolldownOptions: {
        input: { harness: join(frontend, 'scripts/settings-v6-browser-harness.ts') },
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'assets/[name].js' },
      },
    },
  });
  const names = await readdir(join(bundle, 'assets'));
  report['build_inputs'] = await Promise.all(names.map(async (name) => {
    const bytes = await readFile(join(bundle, 'assets', name));
    return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  server.middlewares.use((request, response, next) => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/__settings_v6__') { next(); return; }
    const styles = names.filter((name) => name.endsWith('.css')).map((name) => `<link rel="stylesheet" href="/assets/${name}">`).join('');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设置 V6 浏览器验收</title>${styles}<body><script>window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));const original=console.error;console.error=(...args)=>{window.__errors.push(args.map(String).join(' '));original(...args);};</script><script type="module">import * as harness from '/assets/harness.js';window.__harness=harness;await harness.mount();window.__mounted=true;</script></body></html>`);
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  port = address.port;
  const url = `http://127.0.0.1:${port}/__settings_v6__#settings`;
  report['url'] = url;
  // 新建独占 profile 前检查同一命令不存在，禁止重复拉起同一验收浏览器。
  const escaped = profile.replaceAll("'", "''");
  const processes = await execute('powershell.exe', ['-NoProfile', '-Command',
    `$target='${escaped}'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like ('*' + $target + '*') }).Count`,
  ], { windowsHide: true });
  assert.equal(Number(processes.stdout.trim()), 0, '同一验收 profile 已有浏览器实例');
  stage = '独占真实浏览器';
  browser = await createDefaultsBrowser(project, profile, evidence);
  await browser.navigate(url);
  await browser.wait('window.__mounted===true', '设置 App 装配');
  const capture = async (name: string, width = 1424, height = 805) => {
    assert.ok(browser);
    const path = join(output, name + '.png');
    await browser.capture(path, width, height);
    captures.push({ name, path, width, height });
  };
  await capture('01-服务连接-默认态');
  report['default'] = await browser.evaluate('window.__harness.snapshot()');
  stage = '连接与市场行为';
  await browser.evaluate('window.__harness.verifyConnections()');
  await capture('02-服务连接-连接失败');
  report['failure'] = await browser.evaluate('window.__harness.snapshot()');
  stage = '分类和插件草稿';
  await browser.evaluate('window.__harness.verifyDrafts()');
  await browser.evaluate('window.__harness.prepareKeyboardNavigation()');
  report['keyboard_before'] = await browser.evaluate('({focused:document.hasFocus(),tag:document.activeElement?.tagName,text:document.activeElement?.textContent})');
  await browser.pressKey('Tab');
  report['keyboard_after_tab'] = await browser.evaluate('({focused:document.hasFocus(),tag:document.activeElement?.tagName,text:document.activeElement?.textContent})');
  await browser.pressKey('Enter');
  report['keyboard_after_enter'] = await browser.evaluate('({focused:document.hasFocus(),tag:document.activeElement?.tagName,text:document.activeElement?.textContent,current:document.querySelector("nav[aria-label=设置分类] [aria-current=page]")?.textContent})');
  await browser.evaluate('window.__harness.verifyKeyboardNavigation()');
  await browser.evaluate('window.__harness.choose("工具配置")');
  await capture('03-工具配置');
  await browser.evaluate('window.__harness.choose("外观与主题")');
  await capture('04-外观与主题');
  await browser.evaluate('window.__harness.verifyPlugin()');
  await capture('05-插件扩展');
  await capture('06-窄屏-插件扩展', 940, 760);
  await browser.evaluate('window.__harness.verifyNarrow()');
  await capture('07-窄屏-工具配置', 940, 760);
  report['final'] = await browser.evaluate('window.__harness.snapshot()');
  report['console_errors'] = await browser.evaluate('window.__errors');
  assert.deepEqual(report['console_errors'], [], '浏览器发生未预期控制台错误');
  report['app_cleanup'] = await browser.evaluate('window.__harness.dispose()');
  report['source_inputs_stable'] = await Promise.all(sourceHashes.map(async (item) => {
    const bytes = await readFile(join(frontend, item.path));
    return { path: item.path, stable: item.sha256 === createHash('sha256').update(bytes).digest('hex') };
  }));
  assert.ok(Array.isArray(report['source_inputs_stable']) && report['source_inputs_stable'].every((item: unknown) => item !== null && typeof item === 'object' && 'stable' in item && item.stable === true), '浏览器验收期间受测源码变化');
  report['passed'] = true;
} catch (error) {
  report['stage'] = stage;
  report['error'] = error instanceof Error ? error.message : String(error);
  report['failure_page'] = await browser?.evaluate('({text:document.body.innerText,errors:window.__errors,focused:document.hasFocus(),activeText:document.activeElement?.textContent,activeTag:document.activeElement?.tagName})').catch(() => null);
  await browser?.capture(join(output, 'failure.png'), 1424, 805).catch(() => {});
} finally {
  await browser?.evaluate('window.__harness?.dispose()').catch((error: unknown) => { report['cleanup_error'] = error instanceof Error ? error.message : String(error); });
  await browser?.close();
  browserClosed = true;
  const escapedProfile = profile.replaceAll("'", "''");
  try {
    const remaining = await execute('powershell.exe', ['-NoProfile', '-Command',
      `$taskProfile='${escapedProfile}'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like ('*' + $taskProfile + '*') }).Count`,
    ], { windowsHide: true });
    report['owned_browser_processes_remaining'] = Number(remaining.stdout.trim());
    if (report['owned_browser_processes_remaining'] !== 0) report['passed'] = false;
  } catch (error) {
    report['process_verification_error'] = error instanceof Error ? error.message : String(error);
    report['passed'] = false;
  }
  const listener = server.httpServer;
  if (listener && 'closeAllConnections' in listener) listener.closeAllConnections();
  await server.close();
  report['http_listener'] = { port, released: port ? await listenerReleased(port) : true };
  const profileRelative = relative(output, profile);
  assert.ok(profile.startsWith(output + sep) && !profileRelative.startsWith('..') && basename(profile) === 'browser-profile');
  try {
    assert.ok(browserClosed && report['owned_browser_processes_remaining'] === 0 && report['http_listener'] !== null, '必须先关闭本轮浏览器与HTTP再清理profile');
    let removed = false;
    for (let attempt = 0; attempt < 6 && !removed; attempt++) {
      try { await rm(profile, { recursive: true, force: true }); removed = true; }
      catch (error) {
        if (attempt === 5) throw error;
        await delay(200 * (attempt + 1));
      }
    }
    report['profile_cleaned'] = removed;
  } catch (error) {
    report['profile_cleaned'] = false;
    report['profile_cleanup_error'] = error instanceof Error ? error.message : String(error);
    report['passed'] = false;
  }
  report['completed_at'] = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (report['passed'] !== true) process.exitCode = 1;
  console.log(`设置 V6 浏览器验收：${report['passed'] === true ? '通过' : '未通过'}；证据：${output}`);
}
