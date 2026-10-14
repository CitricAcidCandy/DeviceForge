import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { runMediaBrowser } from './browser-media-driver.ts';

interface Identity {path: string; bytes: number; sha256: string}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const frontend = fileURLToPath(new URL('../', import.meta.url)); const project = resolve(frontend, '..');
const sourceDirectory = join(frontend, 'src'); const scriptsDirectory = join(frontend, 'scripts');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function identity(path: string): Promise<Identity> {const bytes = await readFile(path); return {path, bytes: bytes.length, sha256: hash(bytes)};}
async function sources(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path)); else if (/\.tsx?$/.test(entry.name)) result.push(path);
  }
  return result;
}
const runId = randomUUID(); const report: Record<string, unknown> = {timestamp: new Date().toISOString(), run_id: runId, passed: false,
  scope: '独立临时生产构建、真实 MediaPage/ProductServices、原生 H.264 编解码与 WebAudio 图、受控 HTTP 协议夹具；不含 Rust 服务、真实设备、桌面输入、扬声器听觉、视觉审核或生产性能'};
let temporary: string | null = null; let server: ViteDevServer | null = null; let stage = '冻结实际构建源码';
try {
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-media-browser-'));
  const initial = new Map<string, Identity>();
  const scriptPaths = (await readdir(scriptsDirectory)).filter(name => /^browser-media-.*\.ts$/.test(name) || name === 'verify-media-browser.ts').map(name => join(scriptsDirectory, name));
  for (const path of [...await sources(sourceDirectory), ...scriptPaths]) initial.set(resolve(path), await identity(path));
  const used = new Set<string>(scriptPaths.map(path => resolve(path)));
  const provenance: Plugin = {name: '媒体构建源码身份', generateBundle() {
    for (const id of this.getModuleIds()) {const path = resolve(id.split('?')[0] ?? id); if (initial.has(path)) used.add(path);}
  }};
  const outputDirectory = join(temporary, 'build'); stage = '构建独立真实媒体页面';
  await build({root: frontend, configFile: false, logLevel: 'error', plugins: [react(), provenance],
    resolve: {alias: {'@': sourceDirectory}}, build: {outDir: outputDirectory, emptyOutDir: true, sourcemap: false,
      rolldownOptions: {input: {'browser-media-harness': join(scriptsDirectory, 'browser-media-harness.ts')}, preserveEntrySignatures: 'strict', output: {entryFileNames: 'assets/[name].js'}}}});
  const sourceInputs: Identity[] = [];
  for (const path of used) {const before = initial.get(path); assert.ok(before, '媒体构建源码身份缺失'); const after = await identity(path);
    assert.equal(after.sha256, before.sha256, `构建期间源码发生变化：${relative(frontend, path)}`); sourceInputs.push(before);}
  report['source_inputs'] = sourceInputs;
  const assetsDirectory = join(outputDirectory, 'assets'); const assets = new Map<string, Buffer>(); const assetInputs: Identity[] = [];
  for (const entry of await readdir(assetsDirectory, {withFileTypes: true})) {
    if (!entry.isFile() || !/\.(?:js|css)$/.test(entry.name)) continue;
    const path = join(assetsDirectory, entry.name); const content = await readFile(path);
    assert.ok(content.length <= 8 * 1024 * 1024, '媒体单构建资产超限'); assets.set(entry.name, content); assetInputs.push(await identity(path));
  }
  assert.ok(assets.has('browser-media-harness.js') && assets.size <= 128, '独立媒体构建入口或资产数量无效'); report['asset_inputs'] = assetInputs;
  // 后续仅发布已冻结字节，不借用主 dist 或开发依赖扫描结果。
  server = await createServer({root: temporary, configFile: false, appType: 'custom', logLevel: 'error',
    optimizeDeps: {noDiscovery: true, include: []}, server: {host: '127.0.0.1', port: 0, hmr: false}});
  server.middlewares.use('/assets', (request, response, next) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1); const content = assets.get(path);
    if (!content) {next(); return;} response.setHeader('content-type', path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'); response.end(content);
  });
  server.middlewares.use('/__media_verification__', (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>真实产品原生媒体验收</title><body></body></html>');
  });
  stage = '启动冻结媒体资产服务'; await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string', '媒体资产服务端口缺失');
  const browserEvidence: Record<string, unknown> = {}; report['browser_process'] = browserEvidence;
  stage = '真实浏览器运行媒体页面';
  const result = await runMediaBrowser(`http://127.0.0.1:${address.port}/__media_verification__`, temporary, browserEvidence, process.argv.includes('--in-process-gpu'));
  report['browser'] = result;
  assert.ok(object(result) && result['passed'] === true && Array.isArray(result['checks']) && result['checks'].length >= 11
    && result['checks'].every(check => object(check) && check['passed'] === true) && Array.isArray(result['gaps']), '真实媒体行为没有全部通过或遗漏验收边界');
  stage = '冻结源码与资产身份复核';
  for (const before of [...sourceInputs, ...assetInputs]) {const after = await identity(before.path); assert.equal(after.sha256, before.sha256, `媒体验收期间输入发生变化：${relative(frontend, before.path)}`);}
  report['passed'] = true;
} catch (error) {
  report['failure_stage'] = stage; report['error'] = {name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message.slice(0, 4000) : '未知媒体验收失败'};
  process.exitCode = 1;
} finally {
  const listener = server?.httpServer; if (listener && 'closeAllConnections' in listener) listener.closeAllConnections();
  await server?.close(); report['asset_service_closed'] = true;
  if (temporary) {
    const normalized = resolve(temporary); const parent = resolve(tmpdir()); const subpath = relative(parent, normalized);
    assert.ok(normalized.startsWith(parent + sep) && !subpath.startsWith('..') && basename(normalized).startsWith('deviceforge-media-browser-'), '媒体临时目录清理边界无效');
    await rm(normalized, {recursive: true, force: true}); report['temporary_cleaned'] = true;
  }
  report['completed_at'] = new Date().toISOString();
  const directory = join(project, 'artifacts', `browser-media-${runId}`); await mkdir(directory, {recursive: true});
  const output = join(directory, 'report.json'); await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`原生产品媒体验收：${report['passed'] === true ? '通过' : '未通过'}；证据：${output}`);
  if (report['error']) console.error(report['error']);
}
