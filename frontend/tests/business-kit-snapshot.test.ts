import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, createElement, Fragment, StrictMode, useLayoutEffect } from 'react';
import { JSDOM } from 'jsdom';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { hash, unpackPublicPackage } from '../scripts/workspace-release-inputs.ts';
import type { SnapshotSource } from '../plugins/business-kit/src/react/index.tsx';

const packageDirectory = process.env['DEVICEFORGE_SNAPSHOT_PACKAGE_DIRECTORY'];
let releaseImports: () => void = () => {};
let packageRoot: string | null = null, temporary: string | null = null;
const packages: { readonly name: string; readonly bytes: number; readonly sha256: string }[] = [];
after(async () => {
  releaseImports();
  if (temporary && packageRoot) {
    const path = resolve(temporary), offset = relative(packageRoot, path);
    assert.ok(offset && !isAbsolute(offset) && !offset.startsWith('..') && offset.startsWith('.snapshot-unit-'),
      '只回收本次归档单元在明确制品目录内创建的独占临时目录');
    await rm(path, { recursive: true, force: true });
  }
});
interface PublicHooks {
  readonly useSnapshot: <T>(source: SnapshotSource<T>) => T;
}
function publicHooks(value: unknown): value is PublicHooks {
  return value !== null && typeof value === 'object' &&
    'useSnapshot' in value && typeof value.useSnapshot === 'function';
}
let loaded: unknown;
if (packageDirectory) {
  packageRoot = await realpath(packageDirectory);
  temporary = await mkdtemp(join(packageRoot, '.snapshot-unit-'));
  const issuedImports = new Map<string, string>();
  for (const name of ['plugin-sdk', 'business-kit']) {
    const archive = join(packageRoot, `deviceforge-${name}-0.1.0.tgz`);
    const content = await readFile(archive);
    const unpacked = await unpackPublicPackage(archive, join(temporary, name));
    assert.equal(unpacked.name, `@deviceforge/${name}`);
    packages.push({ name: unpacked.name, bytes: content.length, sha256: hash(content) });
    for (const [specifier, file] of Object.entries(unpacked.imports))
      issuedImports.set(specifier, pathToFileURL(file).href);
  }
  const entry = issuedImports.get('@deviceforge/business-kit/react');
  assert.ok(entry, '实际TGZ缺少公开react出口，禁止回退源码');
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = issuedImports.get(specifier);
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  releaseImports = () => hooks.deregister();
  loaded = await import(entry);
} else {
  const imports = registerCompositionStartupImports();
  releaseImports = imports.dispose;
  loaded = await import('../plugins/business-kit/src/react/index.tsx');
}
assert.ok(publicHooks(loaded), '公开业务套件没有实际导出useSnapshot');
const { useSnapshot } = loaded;
const { createRoot } = await import('react-dom/client');

for (const strict of [false, true]) {
  test(`业务快照在渲染与订阅之间完成时立即显示最新结果${strict ? '，含严格模式重订阅' : ''}`, async (t) => {
    if (packageDirectory) t.diagnostic(`实际TGZ：${JSON.stringify(packages)}`);
    const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>');
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      window: browser.window, document: browser.window.document,
      navigator: browser.window.navigator, HTMLElement: browser.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const target = browser.window.document.querySelector('main');
    assert.ok(target);
    const root = createRoot(target);
    let current = { pending: true, value: '正在读取' };
    const listeners = new Set<(value: typeof current) => void>();
    const source: SnapshotSource<typeof current> = {
      snapshot: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    function publish(value: typeof current) {
      current = value;
      for (const listener of [...listeners]) listener(current);
    }
    function Content() {
      const snapshot = useSnapshot(source);
      return createElement(Fragment, null,
        createElement('p', { role: 'status' }, snapshot.pending ? '正在读取' : snapshot.value),
        createElement('input', { 'aria-label': '业务草稿', defaultValue: '尚未保存' }),
      );
    }
    function Completion() {
      useLayoutEffect(() => {
        publish({ pending: false, value: '已取得业务结果' });
      }, []);
      return null;
    }
    const content = createElement(Fragment, null, createElement(Content), createElement(Completion));
    try {
      await act(async () => { root.render(strict ? createElement(StrictMode, null, content) : content); });
      assert.equal(target.querySelector('[role="status"]')?.textContent, '已取得业务结果',
        '提交阶段已完成的结果不能因尚未订阅而永久停在读取中');
      assert.equal(listeners.size, 1);
      const input = target.querySelector('input');
      assert.ok(input);
      input.value = '继续保留的草稿';
      await act(async () => { publish({ pending: false, value: '后续独立结果' }); });
      assert.equal(target.querySelector('[role="status"]')?.textContent, '后续独立结果');
      assert.equal(target.querySelector('input'), input);
      assert.equal(input.value, '继续保留的草稿');
    } finally {
      await act(async () => { root.unmount(); });
      assert.equal(listeners.size, 0);
      browser.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}
