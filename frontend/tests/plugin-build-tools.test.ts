import test from 'node:test';
import { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ChildProcess } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import * as ts from 'typescript';
import { JSDOM } from 'jsdom';
import { buildBrowserPlugin } from '@deviceforge/plugin-tools';
import type { PluginModuleImports } from '@deviceforge/plugin-tools';
import { readWorkspaceBuildTool } from '../scripts/workspace-build-tool.ts';
import { sdkBrowserPackage } from '../scripts/sdk-repository.ts';

const require = createRequire(import.meta.url);
const frontend = fileURLToPath(new URL('../', import.meta.url));
const toolsRoot = sdkBrowserPackage(frontend, 'tools');
const toolInternals: { inspectOutput(root: string): Promise<readonly PluginModuleImports[]> } =
  await import(pathToFileURL(join(toolsRoot, 'lib/imports.js')).href);
const { inspectOutput } = toolInternals;
const toolWorker = resolve(toolsRoot, 'lib/worker.js');
const children = new Map<number, { command: string; exited: boolean }>();
const originalEmit = ChildProcess.prototype.emit;
mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...values: unknown[]) {
  if (event === 'spawn' && this.pid && this.spawnargs.some((arg) =>
    resolve(arg) === toolWorker)) {
    const state = { command: this.spawnargs.join(' '), exited: false };
    children.set(this.pid, state);
    this.once('exit', () => { state.exited = true; });
  }
  return Reflect.apply(originalEmit, this, [event, ...values]);
});
after(() => {
  mock.restoreAll();
  for (const [pid, state] of children) assert.equal(state.exited, true, `构建进程未回收：${pid}`);
  console.log(`构建子进程回收：${JSON.stringify([...children].map(([pid, state]) => ({ pid, ...state })))}`);
});
async function fixture(unit: test.TestContext, directory = join(frontend, 'artifacts')) {
  await mkdir(directory, { recursive: true });
  const parent = await realpath(directory), root = await mkdtemp(join(parent, 'deviceforge-plugin-build-'));
  unit.after(async () => {
    const target = await realpath(root);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith('deviceforge-plugin-build-'));
    await rm(target, { recursive: true, force: true });
  });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"independent-plugin","type":"module"}');
  return {
    root, outputDir: join(root, 'dist'),
    async source(name: string, text: string) {
      const file = join(root, 'src', name);
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); return file;
    },
  };
}

test('独立构建保留共享React裸导入、延迟CSS与Worker，并提供显式样式释放', async (unit) => {
  const f = await fixture(unit);
  const published = join(f.root, 'published');
  await mkdir(published);
  await writeFile(join(published, 'package.json'), '{"name":"public-helper","version":"1","type":"module"}');
  await writeFile(join(published, 'index.js'), 'export const value="真实公开包";');
  await writeFile(join(f.root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>');
  await f.source('worker.ts', 'import {value} from "public-helper";self.postMessage(value);');
  await f.source('lazy.tsx', 'export async function lazy(){await import("@xterm/xterm/css/xterm.css");return <p className="underline">延迟页面</p>;}');
  const entry = await f.source('index.tsx', `
import React from "react";
import {createRoot} from "react-dom/client";
import {createPortal} from "react-dom";
import {jsx} from "react/jsx-runtime";
import {jsxDEV} from "react/jsx-dev-runtime";
import {Button} from "deviceforge-host";
export default (identity) => ({...identity, activate(){return React.version;}});
export const view = () => <main className="flex gap-3 text-brand dark:bg-brand bg-[url('./icon.svg')]">市场<Button/></main>;
export const helpers = {createRoot, createPortal, jsx, jsxDEV};
export const lazy = () => import("./lazy.tsx");
export const start = () => new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
`);
  const original = await readFile(entry, 'utf8');
  const result = await buildBrowserPlugin({
    root: f.root, outputDir: f.outputDir,
    dependencies: {
      'public-helper': join(published, 'index.js'),
      '@xterm/xterm/css/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
    },
    theme: '@custom-variant dark (&:where(.dark, .dark *));@theme { --color-brand: #123456; }',
  });
  assert.equal(result.entryFile, 'index.js'); assert.equal(result.stylesFile, 'styles.js');
  assert.match(result.buildId, /^[a-f0-9]{64}$/u);
  assert.equal(await readFile(entry, 'utf8'), original);
  assert.deepEqual([...result.hostImports].sort(), [
    'deviceforge-host', 'react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', 'react/jsx-runtime',
  ].sort());
  const code = await readFile(join(f.outputDir, 'index.js'), 'utf8');
  assert.match(code, /from\s*["']react["']/u);
  assert.ok(result.imports.some((module) => module.dynamic.some((path) => path.includes('lazy'))));
  assert.ok(result.files.some((file) => file.path.includes('worker') && file.path.endsWith('.js')));
  const worker = result.files.find((file) => file.path.includes('worker') && file.path.endsWith('.js')); assert.ok(worker);
  assert.match(await readFile(join(f.outputDir, worker.path), 'utf8'), /真实公开包/u);
  const css = (await Promise.all(result.css.map((file) => readFile(join(f.outputDir, file), 'utf8')))).join('\n');
  assert.match(css, /\.flex/u); assert.match(css, /#123456/u); assert.match(css, /\.xterm/u);
  assert.match(css, /\.dark/u); assert.doesNotMatch(css, /prefers-color-scheme/u);
  assert.ok(result.files.some((file) => file.path.startsWith('assets/') && file.path.endsWith('.svg')));
  assert.match(css, /url\([^)]*\.svg/u);
  const styles: { acquireStyles: (document: Document) => () => void } =
    await import(pathToFileURL(join(f.outputDir, result.stylesFile)).href);
  const browser = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  try {
    assert.equal(browser.window.document.querySelectorAll('link').length, 0);
    const first = styles.acquireStyles(browser.window.document), second = styles.acquireStyles(browser.window.document);
    assert.equal(browser.window.document.querySelectorAll('link[rel="stylesheet"]').length, result.css.length);
    first(); first();
    assert.equal(browser.window.document.querySelectorAll('link').length, result.css.length);
    second();
    assert.equal(browser.window.document.querySelectorAll('link').length, 0);
  } finally { browser.window.close(); }
});

test('业务URL以运行期服务器为基址，延迟视图不被误报为安装包资源', async (unit) => {
  const f = await fixture(unit);
  await f.source('index.ts', 'export default () => ({});export const view=()=>import("./view.ts");');
  await f.source('view.ts', `
export const mcp=(baseUrl:string)=>new URL("/mcp",baseUrl);
export const health=(baseUrl:string)=>new URL("/api/v2/health",new URL(baseUrl));
export const external=()=>new URL("https://api.example.test/path");
export const relative=(baseUrl:string)=>new URL("v2/status",baseUrl);
`);
  const result = await buildBrowserPlugin({ root: f.root, outputDir: f.outputDir });
  const chunk = result.files.find((file) => /^chunks\/view-/u.test(file.path));
  assert.ok(chunk);
  assert.match(await readFile(join(f.outputDir, chunk.path), 'utf8'), /new URL\(["']\/mcp["'],/u);
  assert.ok(result.imports.every((module) => !module.assets.some((path) =>
    path.includes('/mcp') || path.includes('api.example.test') || path.includes('v2/status'))));
});

test('仅import.meta.url基址进入静态资源目录，真实绝对和外部模块资源仍拒绝', async (unit) => {
  const f = await fixture(unit);
  await writeFile(join(f.root, 'asset.txt'), '真实资源');
  const entry = join(f.root, 'index.js');
  await writeFile(entry, `
export const business=(baseUrl)=>new URL("/mcp",baseUrl);
export const nested=(baseUrl)=>new URL("/api/v2",new URL(baseUrl));
export const local=new URL("./asset.txt",import.meta.url);
export const bracket=new URL("./asset.txt",import.meta["url"]);
`);
  const catalog = await inspectOutput(f.root);
  assert.deepEqual(catalog.find((module) => module.file === 'index.js')?.assets, ['./asset.txt']);
  for (const path of ['/asset.js', 'https://cdn.example.test/asset.js', '//cdn.example.test/asset.js',
    'file:///private/asset.js', 'blob:https://example.test/id']) {
    await writeFile(entry, `export const asset=new URL(${JSON.stringify(path)},import.meta.url);`);
    await assert.rejects(inspectOutput(f.root), /绝对资源地址/u);
  }
  await writeFile(entry, 'export const worker=()=>new Worker(new URL("./absent-worker.js",import.meta.url),{type:"module"});');
  await assert.rejects(inspectOutput(f.root), /资源缺失/u);
  await writeFile(join(f.root, 'worker.js'), 'self.postMessage("真实Worker");');
  await writeFile(entry, 'export const worker=()=>new Worker(new URL("./worker.js",import.meta.url),{type:"module"});');
  const worker = await inspectOutput(f.root);
  assert.deepEqual(worker.find((module) => module.file === 'index.js')?.assets, ['./worker.js']);
});

test('构建不读取工程Vite配置或development出口，失败保留已有产物和无关文件', async (unit) => {
  const f = await fixture(unit), dependency = join(f.root, 'node_modules', 'condition-helper');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({
    name: 'condition-helper', version: '1', type: 'module',
    exports: { development: './dev.js', browser: './browser.js', import: './prod.js' },
  }));
  await writeFile(join(dependency, 'dev.js'), 'throw new Error("不可使用开发源码");');
  await writeFile(join(dependency, 'browser.js'), 'export const channel="浏览器发行入口";');
  await writeFile(join(dependency, 'prod.js'), 'export const channel="普通发行入口";');
  await writeFile(join(f.root, 'vite.config.ts'), 'throw new Error("不可执行工程配置");');
  await writeFile(join(f.root, 'postcss.config.mjs'), 'throw new Error("不可执行工程PostCSS配置");');
  await mkdir(f.outputDir); await writeFile(join(f.outputDir, 'untouched.txt'), '原文件');
  const entry = await f.source('index.ts', 'export {channel} from "condition-helper";export default () => ({apiVersion:2});');
  const result = await buildBrowserPlugin({ root: f.root, outputDir: f.outputDir });
  const previous = await readFile(join(f.outputDir, result.entryFile), 'utf8');
  assert.match(previous, /浏览器发行入口/u); assert.doesNotMatch(previous, /不可使用开发源码/u);
  await writeFile(entry, 'export default () => { 语法错误 ;');
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: f.outputDir }));
  assert.equal(await readFile(join(f.outputDir, 'index.js'), 'utf8'), previous);
  assert.equal(await readFile(join(f.outputDir, 'untouched.txt'), 'utf8'), '原文件');
  assert.ok((await readdir(f.root)).every((name) => !name.startsWith('.deviceforge-build-')));
});

test('输出和入口越界、私有TS依赖及未声明React子路径在写入前拒绝', async (unit) => {
  const f = await fixture(unit);
  const entry = await f.source('index.ts', 'export default () => ({});');
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: resolve(f.root, '..') }), /输出/u);
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: f.outputDir, entry: '../outside.ts' }), /入口/u);
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: f.outputDir, dependencies: { helper: entry } }), /发行|模块/u);
  await writeFile(entry, 'export {renderToString} from "react-dom/server";');
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: f.outputDir }), /importmap|共享/u);
  assert.equal((await readdir(f.root)).includes('dist'), false);
});

test('取消已启动构建进程会有界退出并保留旧输出，预取消零构建副作用', async (unit) => {
  const f = await fixture(unit), controller = new AbortController();
  await f.source('index.ts', 'export default () => ({});');
  await mkdir(f.outputDir); await writeFile(join(f.outputDir, 'index.js'), '旧入口');
  const emit = ChildProcess.prototype.emit;
  let online = 0;
  unit.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...values: unknown[]) {
    const result = Reflect.apply(emit, this, [event, ...values]);
    if (event === 'spawn') { online++; controller.abort(new Error('停止本次构建')); }
    return result;
  });
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: f.outputDir, signal: controller.signal }), /停止本次构建/u);
  assert.equal(online, 1);
  assert.equal(await readFile(join(f.outputDir, 'index.js'), 'utf8'), '旧入口');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: f.outputDir, signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(online, 1);
});

test('工具共享模块清单逐项对应当前宿主importmap', async () => {
  const frontend = fileURLToPath(new URL('../', import.meta.url));
  const html = await readFile(join(frontend, 'index.html'), 'utf8');
  for (const name of ['deviceforge-host', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'])
    assert.ok(html.includes(`"${name}":`), `当前宿主没有提供 ${name}`);
  const tools = sdkBrowserPackage(frontend, 'tools');
  assert.equal(await realpath(join(tools, 'lib', 'index.js')), resolve(tools, 'lib', 'index.js'));
});

test('重复构建仅更新所属文件，保留旧块，拒绝覆盖归属未知的同名产物', async (unit) => {
  const f = await fixture(unit);
  const entry = await f.source('index.ts', 'export default () => ({});export const lazy=()=>import("./lazy.ts");');
  const lazy = await f.source('lazy.ts', 'export const value="第一版延迟模块";');
  const first = await buildBrowserPlugin({ root: f.root, outputDir: f.outputDir, entry });
  const oldChunk = first.files.find((file) => file.path.startsWith('chunks/')); assert.ok(oldChunk);
  await writeFile(lazy, 'export const value="第二版延迟模块";');
  const second = await buildBrowserPlugin({ root: f.root, outputDir: f.outputDir, entry: 'src/index.ts' });
  assert.notEqual(first.buildId, second.buildId);
  assert.match(await readFile(join(f.outputDir, oldChunk.path), 'utf8'), /第一版延迟模块/u);
  const other = join(f.root, 'other-output');
  await mkdir(other); await writeFile(join(other, 'index.js'), '不属于构建工具的原入口');
  await assert.rejects(buildBrowserPlugin({ root: f.root, outputDir: other }), /归属未知/u);
  assert.deepEqual(await readdir(other), ['index.js']);
  assert.equal(await readFile(join(other, 'index.js'), 'utf8'), '不属于构建工具的原入口');
});

test('跨工程私有导入和计算动态模块不能绕过公开依赖闭包', async (unit) => {
  const f = await fixture(unit), project = join(f.root, 'project');
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(f.root, 'private.ts'), 'export const secret="宿主私有实现";');
  const entry = join(project, 'src', 'index.ts');
  await writeFile(entry, 'export {secret} from "../../private.ts";');
  await assert.rejects(buildBrowserPlugin({ root: project, outputDir: join(project, 'dist') }), /公开发行包边界/u);
  await writeFile(entry, 'export const load=(path)=>import(/* @vite-ignore */ path);');
  await assert.rejects(buildBrowserPlugin({ root: project, outputDir: join(project, 'dist') }), /动态导入/u);
  await writeFile(entry, `export {useState} from ${JSON.stringify(require.resolve('react').replaceAll('\\', '/'))};`);
  await assert.rejects(buildBrowserPlugin({ root: project, outputDir: join(project, 'dist') }), /共享 React/u);
  await writeFile(join(project, 'src', 'worker.ts'), 'import {version} from "react";self.postMessage(version);');
  await writeFile(entry, 'export const start=()=>new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});');
  await assert.rejects(buildBrowserPlugin({ root: project, outputDir: join(project, 'dist') }), /Worker.*importmap/u);
});

test('实际工程盘输出通过同盘临时文件提交，跨卷暂存不触发EXDEV', async (unit) => {
  const packageRoot = sdkBrowserPackage(fileURLToPath(new URL('../', import.meta.url)), 'tools');
  const f = await fixture(unit);
  if (process.platform === 'win32') assert.notEqual(parse(f.root).root, parse(await realpath(tmpdir())).root);
  await f.source('index.ts', 'export default () => ({apiVersion:2});');
  const result = await buildBrowserPlugin({ root: f.root, outputDir: f.outputDir });
  assert.equal(result.outputDir, f.outputDir);
  assert.match(await readFile(join(f.outputDir, 'index.js'), 'utf8'), /apiVersion/u);
  assert.ok((await readdir(f.outputDir)).every((name) => !name.startsWith('.deviceforge-write-')));
});

test('真实TGZ自带ESM与声明，可作为独立工程公开依赖消费', async (unit) => {
  const packageRoot = sdkBrowserPackage(fileURLToPath(new URL('../', import.meta.url)), 'tools');
  const f = await fixture(unit);
  const published = join(f.root, 'node_modules', '@deviceforge', 'plugin-tools');
  await mkdir(published, { recursive: true });
  const metadata: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.ok(metadata && typeof metadata === 'object' && 'version' in metadata &&
    typeof metadata.version === 'string' && /^\d+\.\d+\.\d+$/.test(metadata.version));
  const archive = gunzipSync((await readWorkspaceBuildTool(frontend)).content);
  const members: string[] = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.ok(name.startsWith('package/'));
    const target = resolve(published, name.slice('package/'.length));
    assert.ok(!relative(published, target).startsWith('..'));
    assert.equal(header[156], 48);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, archive.subarray(offset + 512, offset + 512 + size));
    members.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(members.includes('package/lib/index.js'));
  assert.ok(members.includes('package/lib/index.d.ts'));
  assert.ok(members.every((member) => !member.startsWith('package/src/')));
  const entry = await f.source('consume.ts', `
import {buildBrowserPlugin, type BrowserPluginBuildResult} from "@deviceforge/plugin-tools";
import {generatePluginContracts, type GeneratedPluginContracts} from "@deviceforge/plugin-tools";
const generated: GeneratedPluginContracts = generatePluginContracts({});
void generated;
const result: Promise<BrowserPluginBuildResult> = buildBrowserPlugin({
  root: ".", entry: "src/index.ts", outputDir: "dist",
  dependencies: {"public-package": "C:/published/index.js"},
  theme: "@custom-variant dark (&:where(.dark, .dark *));",
  signal: new AbortController().signal,
});
void result;
`);
  const program = ts.createProgram([entry], {
    noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
  const publishedApi: typeof import('@deviceforge/plugin-tools') =
    await import(pathToFileURL(join(published, 'lib', 'index.js')).href);
  assert.equal(typeof publishedApi.buildBrowserPlugin, 'function');
  assert.equal(typeof publishedApi.generatePluginContracts, 'function');
  const manifest: unknown = JSON.parse(await readFile(new URL('../../examples/workspace-suite/manifest.json', import.meta.url), 'utf8'));
  const generated = publishedApi.generatePluginContracts(manifest);
  assert.equal(generated.services[0]?.id, 'example.workspace.normalize');
  assert.match(generated.source, /ExampleWorkspaceNormalizeV1Submit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(publishedApi.buildBrowserPlugin({
    root: f.root, outputDir: f.outputDir, signal: controller.signal,
  }), { name: 'AbortError' });
});
