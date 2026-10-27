import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '../frontend/node_modules/typescript/lib/typescript.js';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { npmTgz } from '../backend/scripts/online-plugins/fixtures.mjs';
import { smokeBinary } from '../backend/scripts/smoke-binaries.mjs';
import { mountBuiltBrowserAssets } from './browser-built-assets.mjs';
import { runBrowser } from './browser-theme-smoke/driver.mjs';
import { bounded, normalExit, observeChild } from './unified-discovery-browser/lifecycle.mjs';
import { assertListenerReleased } from './unified-discovery-smoke/host.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const providerId = 'example.service-provider';
const consumerId = 'example.service-consumer';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// 裸模块名保留给真实浏览器链接器；每个导出的身份都与生产宿主实例比较。
const reactProbe = `import React, { useState, useEffect, createElement, Fragment } from 'react';
import Client, { createRoot, hydrateRoot } from 'react-dom/client';
import DOM, { createPortal, flushSync, preconnect } from 'react-dom';
import JSX, { jsx, jsxs, Fragment as JSXFragment } from 'react/jsx-runtime';
import DEV, { jsxDEV, Fragment as DEVFragment } from 'react/jsx-dev-runtime';
export function probe() {
  const ui = globalThis.__DEVICEFORGE_HOST_UI__;
  if (!ui) throw new Error('缺少生产宿主公共UI');
  const result = {
    react: React === ui.React && useState === ui.React.useState && useEffect === ui.React.useEffect && createElement === ui.React.createElement && Fragment === ui.React.Fragment,
    client: Client === ui.ReactDOMClient && createRoot === ui.ReactDOMClient.createRoot && hydrateRoot === ui.ReactDOMClient.hydrateRoot,
    dom: DOM === ui.ReactDOM && createPortal === ui.ReactDOM.createPortal && flushSync === ui.ReactDOM.flushSync && preconnect === ui.ReactDOM.preconnect,
    jsx: JSX === ui.jsxRuntime && jsx === ui.jsxRuntime.jsx && jsxs === ui.jsxRuntime.jsxs && JSXFragment === ui.jsxRuntime.Fragment,
    dev: DEV === ui.jsxDevRuntime && jsxDEV === ui.jsxDevRuntime.jsxDEV && DEVFragment === ui.jsxDevRuntime.Fragment,
  };
  if (Object.values(result).some((value) => !value)) throw new Error('React共享入口身份不符');
  return { data: result, logId: null };
}
export async function mountShared(target) {
  probe();
  const container = target.ownerDocument.createElement('div');
  const portal = target.ownerDocument.createElement('div');
  portal.dataset.sharedPortal = '';
  target.append(container, portal);
  function Counter() {
    const [count, setCount] = useState(0);
    useEffect(() => { container.dataset.effect = 'active'; return () => { delete container.dataset.effect; }; }, []);
    return jsxs(Fragment, { children: [
      jsx('button', { type: 'button', onClick: () => setCount((value) => value + 1), children: '共享计数：' + count }),
      createPortal(jsx('output', { children: '共享门户' }), portal),
    ] });
  }
  const instance = createRoot(container);
  flushSync(() => instance.render(jsx(Counter, {})));
  return () => { flushSync(() => instance.unmount()); container.remove(); portal.remove(); };
}
`;

export async function createServiceFixtures(project = root) {
  const fixtures = [];
  for (const [kind, id] of [['provider', providerId], ['consumer', consumerId]]) {
    const sourcePath = join(project, 'frontend', 'src', 'plugins', 'examples', `service-${kind}.ts`);
    const source = await readFile(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, { fileName: sourcePath, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } });
    assert.ok(!(compiled.diagnostics ?? []).some((entry) => entry.category === ts.DiagnosticCategory.Error), '独立示例转译失败');
    assert.ok(!/^import\s/m.test(compiled.outputText), '独立示例出现非SDK类型的运行时源码依赖');
    const commands = `[{ id: '${id}.react-probe', title: '共享React入口', execute: async () => probe() }${kind === 'consumer' ? `,
      { id: '${id}.independent-command', title: '独立功能', execute: async () => ({ data: '独立功能仍可用', logId: null }) },
      { id: '${id}.diagnostics', title: '功能诊断', execute: async () => ({ data: context.services.diagnostics(), logId: null }) }` : ''}]`;
    const entry = `import original from './example.js';
import { probe, mountShared } from './react-probe.js';
// 附加验收观测也只使用公开SDK；原始示例的服务与功能注册不变。
export default { ...original, async activate(context) {
  if (!context.extensions?.register) throw new Error('缺少公开动态注册入口');
  probe();
  context.extensions.register({ commands: ${commands}${kind === 'consumer' ? `,
    components: [{ id: '${id}.independent', title: '独立组件', slot: 'service.independent', mount: mountShared }],
    modules: [{ id: '${id}.independent-page', title: '独立页面', route: '/service-independent', mount: mountShared }]` : ''} });
  await original.activate?.(context);
} };
`;
    const manifest = { id, version: '1.0.0', api_version: 2 };
    const files = [
      { path: 'package.json', bytes: json({ name: `deviceforge-service-${kind}-smoke`, version: '1.0.0', type: 'module',
        deviceforge: { kind: 'browser', manifest: 'plugin.json', entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } } } }) },
      { path: 'plugin.json', bytes: json(manifest) },
      { path: 'dist/index.js', bytes: entry },
      { path: 'dist/example.js', bytes: compiled.outputText },
      { path: 'dist/react-probe.js', bytes: reactProbe },
    ];
    fixtures.push({ kind, id, sourcePath, source, files, archive: npmTgz(files) });
  }
  return fixtures;
}

export const requiredChecks = [
  '上传两个独立浏览器TGZ', '缺少提供者时仅组合功能等待',
  'React命名入口复用宿主且hooks和portal可用', '提供者上线后发布页面元数据与槽位',
  '公开callTyped贯通两个独立包', '提供者停用仅撤销相关贡献与DOM',
  '独立页面组件命令及React状态保留', '恢复提供者产生新运行URL与代际',
  '产品启动目录未就绪保留直达hash', '产品模块就绪后直达页面与服务调用可用',
  '产品接管等待与失败保留默认内容', '产品卸载当前插件页回到devices',
  '恢复后重挂载新功能且旧节点不复活', '删除安装包撤销全部本轮贡献与挂载',
  '生产宿主释放', '槽位适配器释放', '公共UI与验收节点释放',
];

export function validateBrowserResult(result) {
  assert.equal(result?.passed, true, '浏览器组合验收未通过');
  assert.ok(Array.isArray(result.checks), '浏览器没有逐项结果');
  for (const name of requiredChecks)
    assert.equal(result.checks.filter((entry) => entry.name === name && entry.passed === true).length, 1, `缺少唯一通过证据：${name}`);
  assert.ok(result.checks.every((entry) => entry.passed === true), '浏览器存在失败检查');
}

// 冻结整个 dist，连导入映射、垫片、样式、映射文件和嵌套资产都计入身份。
export async function captureDist(directory) {
  const inputs = [];
  const files = new Map();
  let totalBytes = 0;
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), '生产dist不得包含符号链接');
      const path = join(current, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      assert.ok(entry.isFile() && inputs.length < 1024, '生产dist成员类型或数量无效');
      const content = await readFile(path);
      totalBytes += content.length;
      assert.ok(content.length <= 32 * 1024 * 1024 && totalBytes <= 256 * 1024 * 1024, '生产dist字节数超出验收上限');
      const name = relative(directory, path).replaceAll('\\', '/');
      files.set(name, content);
      inputs.push({ path, name, bytes: content.length, sha256: sha256(content) });
    }
  }
  await visit(directory);
  assert.ok(inputs.length > 0, '生产dist为空');
  return { inputs, files };
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string', '本轮端口预留失败');
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  return address.port;
}

async function call(base, path, options = {}, timeout = 10000) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(timeout) });
  const body = await response.json();
  assert.ok(response.ok, `真实服务请求失败：${response.status} ${path} ${body.error?.code ?? ''}`);
  assert.ok(body.log_id && body.log_id === response.headers.get('x-deviceforge-log-id'), 'HTTP响应缺少关联日志ID');
  return body.data;
}

async function ready(base, evidence) {
  const started = Date.now();
  evidence.readiness = { attempts: 0, interval_ms: 50, timeout_ms: 10000 };
  while (Date.now() - started < 10000) {
    assert.ok(!evidence.close && !evidence.spawn_error, '本轮HTTP服务提前退出');
    evidence.readiness.attempts++;
    try { await call(base, '/api/v2/operations', {}, 1000); return; }
    catch (error) { evidence.readiness.last_error = error.message; }
    await delay(50);
  }
  throw new Error('本轮HTTP服务未在十秒内就绪');
}

function importMap(html) {
  const source = /<script\s+type="importmap"[^>]*>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(source, '生产index.html缺少导入映射');
  const value = JSON.parse(source);
  for (const name of ['deviceforge-host', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']) {
    assert.ok(typeof value.imports?.[name] === 'string' && /^\/[a-zA-Z0-9._/-]+\.js$/u.test(value.imports[name]), `生产导入映射无效：${name}`);
  }
  return value;
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.every((value) => value === '--release') && args.length <= 1, '仅支持一次 --release');
  const profile = args.includes('--release') ? 'release' : 'debug';
  const runId = randomUUID();
  const output = join(root, 'artifacts', `service-composition-browser-${profile}-${runId}`);
  const reportPath = join(root, 'artifacts', `service-composition-browser-${profile}.json`);
  const report = { run_id: runId, timestamp: new Date().toISOString(), profile, platform: process.platform,
    passed: false, checks: [], browser_runtime: { status: '尚未取得' }, process_cleanup: [],
    scope: '真实Rust在线安装、两个独立浏览器TGZ、生产宿主ESM、公开SDK服务组合与React共享实例、生产App/ProductServices直达路由及默认内容回退；不含协议第六版、导航视觉、真机、性能或可信JS副作用强制停止证明',
    boundaries: ['仅本轮独立临时用户根和冻结HTTP二进制', '不构建、不连接用户服务、不操作设备',
      '生产App直达路由消费真实安装包；等待与失败通过公开生命周期注入，不计视觉或其他产品功能验收', '服务失效使用显式停用模拟，不宣称服务器协议第六版通过',
      '失败报告、TGZ、示例源码与临时运行目录保留；不自动重试整轮验收'] };
  let temporary, vite, backend, base, port, proxyPort;
  let stage = '冻结输入';
  const backendEvidence = { role: '本轮HTTP服务', pid: null };
  const browserEvidence = { role: '本轮浏览器' };
  let failure = false;
  const mark = (name, passed, detail) => report.checks.push({ name, passed, ...(detail ? { detail } : {}) });
  const cleanup = async (name, action) => {
    try { await action(); mark(name, true); }
    catch (error) { failure = true; mark(name, false, error.message); }
  };
  try {
    await mkdir(output, { recursive: true });
    temporary = await mkdtemp(join(tmpdir(), `deviceforge-service-${runId}-`));
    const directory = join(root, 'frontend', 'dist');
    const frozen = await captureDist(directory);
    report.host_dist = frozen.inputs;
    const host = frozen.files.get('assets/plugin-host.js');
    const harness = frozen.files.get('assets/browser-service-harness.js');
    assert.ok(host && harness, '缺少生产宿主或browser-service-harness构建入口，请由主代理添加entry并构建');
    const mapping = importMap(frozen.files.get('index.html')?.toString('utf8') ?? '');
    for (const path of Object.values(mapping.imports)) assert.ok(frozen.files.has(path.slice(1)), `生产导入映射目标没有打包：${path}`);
    report.import_map = mapping;
    const fixtures = await createServiceFixtures();
    report.packages = [];
    for (const fixture of fixtures) {
      await writeFile(join(output, `${fixture.kind}.tgz`), fixture.archive);
      await writeFile(join(output, `service-${fixture.kind}.ts`), fixture.source, 'utf8');
      report.packages.push({ id: fixture.id, archive: `${fixture.kind}.tgz`, bytes: fixture.archive.length,
        sha256: sha256(fixture.archive), source: { path: fixture.sourcePath, sha256: sha256(fixture.source) },
        files: fixture.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.bytes), sha256: sha256(file.bytes) })) });
    }
    const sourceBinary = smokeBinary('apk-server', profile);
    const binary = join(temporary, basename(sourceBinary));
    const binaryBytes = await readFile(sourceBinary);
    await copyFile(sourceBinary, binary);
    assert.equal(sha256(await readFile(binary)), sha256(binaryBytes), 'HTTP二进制冻结期间改变');
    report.http_binary = { source_path: sourceBinary, frozen_path: binary, bytes: binaryBytes.length, sha256: sha256(binaryBytes) };
    mark(stage, true);
    stage = '启动本轮前台HTTP服务';
    port = await reservePort();
    base = `http://127.0.0.1:${port}`;
    // 每轮从唯一冻结路径启动，命令行与其他会话不同；只回收原始句柄。
    const child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
      env: { ...process.env, APK_API_TOKEN: '', APK_BIND: `127.0.0.1:${port}`,
        APK_DATA_DIR: join(temporary, 'data'), DEVICEFORGE_USER_DIR: join(temporary, 'user', '.deviceforge'),
        APK_PLUGIN_DIR: join(temporary, 'server-plugins'), APK_BROWSER_PLUGIN_DIR: join(temporary, 'browser-plugins'),
        DEVICEFORGE_NODE: process.execPath } });
    backendEvidence.command = binary;
    backendEvidence.listener = { host: '127.0.0.1', port, released: false };
    backend = observeChild(child, backendEvidence);
    report.backend_process = backendEvidence;
    await ready(base, backendEvidence);
    mark(stage, true);
    stage = '冻结资产代理';
    vite = await createServer({ root: join(root, 'frontend'), configFile: false, appType: 'custom', logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': base } } });
    const built = await mountBuiltBrowserAssets(vite, join(directory, 'assets'));
    for (const input of built.inputs) assert.equal(input.sha256, frozen.inputs.find((entry) => entry.path === input.path)?.sha256, 'JS资产未匹配整个dist冻结身份');
    const modules = new Map([['/__production_host__', host]]);
    for (const fixture of fixtures) modules.set(`/__fixture__/${fixture.kind}.tgz`, fixture.archive);
    const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>公开服务组合验收</title><script type="importmap">${JSON.stringify(mapping)}</script><body></body></html>`;
    vite.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const payload = modules.get(path) ?? frozen.files.get(path.slice(1));
      if (path === '/__service_verification__') {
        response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return;
      }
      if (!payload) { next(); return; }
      response.setHeader('content-type', path.endsWith('.tgz') ? 'application/gzip' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      response.end(payload);
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== 'string', '验收代理端口缺失');
    proxyPort = address.port;
    mark(stage, true);
    stage = '真实浏览器组合验收';
    report.browser_process = browserEvidence;
    report.browser = await runBrowser(`http://127.0.0.1:${proxyPort}/__service_verification__`,
      `(async () => { const harness = await import('/assets/browser-service-harness.js'); return harness.verifyServiceComposition(); })()`,
      join(temporary, 'browser-profile'), (runtime) => { report.browser_runtime = runtime; },
      { evidence: browserEvidence, inProcessGpu: true, onResult: (value) => { report.browser = value; } });
    validateBrowserResult(report.browser);
    assert.equal(browserEvidence.normal_exit, true, '浏览器原始句柄未正常退出');
    assert.equal(browserEvidence.listener?.released, true, '浏览器调试端口没有释放');
    mark(stage, true);
    stage = '安装目录清空';
    assert.deepEqual(await call(base, '/api/v2/plugin-packages/browser'), [], '浏览器安装目录仍有本轮部署');
    assert.deepEqual(await call(base, '/api/v2/plugin-packages/server'), [], '本轮意外产生服务器插件部署');
    mark(stage, true);
    stage = '冻结输入身份复核';
    await built.verify();
    assert.deepEqual((await captureDist(directory)).inputs, frozen.inputs, '宿主dist在本轮验收期间改变');
    for (const fixture of fixtures) assert.equal(sha256(await readFile(fixture.sourcePath)), sha256(fixture.source), '独立模板在验收期间改变');
    assert.equal(sha256(await readFile(sourceBinary)), report.http_binary.sha256, '源HTTP二进制在验收期间改变');
    assert.equal(sha256(await readFile(binary)), report.http_binary.sha256, '冻结HTTP二进制在验收期间改变');
    mark(stage, true);
  } catch (error) {
    failure = true;
    report.failure_stage = stage;
    report.error = { name: error.name ?? 'Error', message: String(error.message).slice(0, 2000) };
    mark(stage, false, report.error.message);
  } finally {
    await cleanup('代理关闭及端口释放', async () => {
      if (vite) {
        vite.httpServer?.closeAllConnections();
        await bounded(vite.close(), 5000, '验收代理关闭超时');
      }
      if (proxyPort) await assertListenerReleased(proxyPort);
      report.process_cleanup.push({ role: '本轮资产代理（当前Node进程内）', pid: process.pid, port: proxyPort ?? null, status: '已关闭' });
    });
    await cleanup('HTTP服务正常退出及端口释放', async () => {
      if (!backend) return;
      try {
        if (!backendEvidence.close && !backendEvidence.spawn_error) {
          try { await call(base, '/api/v2/system/shutdown', { method: 'POST' }, 5000); }
          catch (error) { backendEvidence.shutdown_error = error.message; }
        }
        try { await backend.wait(10000); }
        catch { await backend.force(); }
      } finally {
        backendEvidence.normal_exit = normalExit(backendEvidence);
        if (port) {
          try { await assertListenerReleased(port); backendEvidence.listener.released = true; }
          catch (error) { backendEvidence.listener_error = error.message; }
        }
        report.process_cleanup.push({ role: '本轮HTTP服务', pid: backendEvidence.pid, command: backendEvidence.command,
          status: backendEvidence.close && backendEvidence.listener?.released ? '已回收' : '回收未确认', forced: backendEvidence.forced });
      }
      assert.equal(backendEvidence.normal_exit, true, 'HTTP服务须退出码0并收到close，强制终止不算通过');
      assert.equal(backendEvidence.listener?.released, true, 'HTTP监听端口未释放');
    });
    if (browserEvidence.pid) report.process_cleanup.push({ role: '本轮浏览器', pid: browserEvidence.pid,
      command: browserEvidence.executable_path, status: browserEvidence.close && browserEvidence.listener?.released ? '已回收' : '回收未确认',
      forced: browserEvidence.forced });
    if (browserEvidence.cleanup_error || browserEvidence.port_cleanup_error) failure = true;
    report.passed = !failure;
    if (temporary) {
      const within = relative(tmpdir(), temporary);
      assert.ok(within && !isAbsolute(within) && !within.startsWith('..') && basename(temporary).startsWith(`deviceforge-service-${runId}-`), '本轮临时目录清理边界无效');
      if (report.passed) {
        await cleanup('本轮临时目录回收', async () => {
          await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          report.temporary_cleaned = true;
        });
      }
      if (failure) report.temporary_retained = temporary;
    }
    report.passed = !failure;
    report.completed_at = new Date().toISOString();
    report.immutable_report = join(output, 'report.json');
    await mkdir(output, { recursive: true });
    // 每轮原件先落盘，固定模式路径仅指向最新报告，不覆盖历史失败原件。
    await writeFile(report.immutable_report, json(report), 'utf8');
    await writeFile(reportPath, json(report), 'utf8');
  }
  console.log(json({ passed: report.passed, report: reportPath, original: report.immutable_report }));
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
