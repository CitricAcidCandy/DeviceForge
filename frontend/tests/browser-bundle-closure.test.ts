import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { auditBrowserBundle } from '../scripts/browser-bundle-closure.ts';

let temporary = '';
before(async () => { temporary = await mkdtemp(join(tmpdir(), 'deviceforge-bundle-closure-')); });
after(async () => {
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
  await rm(temporary, { recursive: true, force: true });
});
async function bundle(name: string, source: string) {
  const root = join(temporary, name);
  await mkdir(root);
  await writeFile(join(root, 'index.js'), source);
  return root;
}
test('闭包认可共享 React 及实际延迟块和 Worker，不要求第二份 React', async () => {
  const root = await bundle('valid', 'import React from "react"; export { jsx } from "react/jsx-runtime"; export const lazy = () => import("./view.js"); new Worker(new URL("./worker.js", import.meta.url));');
  await writeFile(join(root, 'view.js'), 'export const value = 42;');
  await writeFile(join(root, 'worker.js'), 'postMessage("ready");');
  const result = await auditBrowserBundle(root);
  assert.deepEqual(result.sharedImports, ['react', 'react/jsx-runtime']);
  assert.equal(result.files.length, 3);
  assert.deepEqual(result.computedImports, []);
});
test('闭包拒绝开发裸名、漏包及 TypeScript，computed import 独立报告不伪造已确认', async () => {
  await assert.rejects(auditBrowserBundle(await bundle('bare', 'import "@deviceforge/business-kit";')), /未映射模块/);
  await assert.rejects(auditBrowserBundle(await bundle('missing', 'import "./missing.js";')), /ENOENT/);
  const root = await bundle('source', 'import "./view.ts";');
  await writeFile(join(root, 'view.ts'), 'export {};');
  await assert.rejects(auditBrowserBundle(root), /TypeScript/);
  const computed = await auditBrowserBundle(await bundle('computed', 'export const load = (url) => import(url);'));
  assert.equal(computed.computedImports.length, 1);
});

test('闭包检查 CSS 的传递导入、字体和图片，不把存在的 CSS 当成资源齐备', async () => {
  const root = await bundle('css', 'import "./style.css";');
  await writeFile(join(root, 'style.css'), '@import "./missing.css";');
  await assert.rejects(auditBrowserBundle(root), /ENOENT/);
  await writeFile(join(root, 'style.css'), '.font { src: url("./missing.woff2?v=1"); }');
  await assert.rejects(auditBrowserBundle(root), /ENOENT/);
  await writeFile(join(root, 'font.woff2'), 'fixture');
  await writeFile(join(root, 'style.css'), '.font { src: url("font.woff2?v=1"); background: url(data:image/png;base64,AA==); }');
  assert.equal((await auditBrowserBundle(root)).files.length, 3);
});

test('Worker 相对 URL 不要求点斜线，其独立模块图不能借用页面 importmap', async () => {
  const root = await bundle('worker-context', 'new Worker(new URL("worker.js", import.meta.url), { type: "module" });');
  await assert.rejects(auditBrowserBundle(root), /ENOENT/);
  await writeFile(join(root, 'worker.js'), 'import "./nested.js";');
  await writeFile(join(root, 'nested.js'), 'import React from "react";');
  await assert.rejects(auditBrowserBundle(root), /Worker.*importmap/);
  await writeFile(join(root, 'nested.js'), 'postMessage("ready");');
  assert.equal((await auditBrowserBundle(root)).files.length, 3);
});

test('Vite Worker 双层同基址 URL 能追踪真实资源，动态或异基址仍拒绝', async () => {
  const root = await bundle('vite-worker', 'new Worker(new URL(new URL("./worker.js", import.meta.url).href, "" + import.meta.url), { type: "module" });');
  await assert.rejects(auditBrowserBundle(root), /ENOENT/);
  await writeFile(join(root, 'worker.js'), 'import React from "react";');
  await assert.rejects(auditBrowserBundle(root), /Worker.*importmap/);
  await writeFile(join(root, 'worker.js'), 'postMessage("ready");');
  assert.equal((await auditBrowserBundle(root)).files.length, 2);
  for (const value of ['new URL(url, import.meta.url).href', 'new URL("./worker.js", otherBase).href']) {
    await writeFile(join(root, 'index.js'), `new Worker(new URL(${value}, "" + import.meta.url));`);
    await assert.rejects(auditBrowserBundle(root), /Worker.*无法确认/);
  }
});
