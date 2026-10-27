import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import type { HostUi } from '../src/plugin-sdk/ui.ts';

const root = resolve(import.meta.dirname, '..');

async function imports(): Promise<Record<string, string>> {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  const source = /<script type="importmap">([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(source, '缺少导入映射');
  const value: unknown = JSON.parse(source);
  assert.ok(value && typeof value === 'object' && 'imports' in value);
  const entries = value.imports;
  assert.ok(entries && typeof entries === 'object');
  const result: Record<string, string> = {};
  for (const [name, path] of Object.entries(entries)) {
    assert.equal(typeof path, 'string');
    if (typeof path === 'string') result[name] = path;
  }
  return result;
}

test('每个 React 包都有独立 ESM 入口，而不是共用不完整导出桶', async () => {
  const paths = await imports();
  const names = ['deviceforge-host', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'];
  assert.equal(new Set(names.map((name) => paths[name])).size, names.length);
});

test('原生 ESM 命名导入覆盖当前 React 模块全部导出且保持宿主函数身份', async () => {
  const previous = globalThis.__DEVICEFORGE_HOST_UI__;
  // 本测试不加载组件或起服，只提供被测模块实际读取的契约分支。
  const fixture: Pick<HostUi, 'React' | 'ReactDOMClient'> & {
    ReactDOM: typeof ReactDOM;
    jsxRuntime: typeof jsxRuntime;
    jsxDevRuntime: typeof jsxDevRuntime;
  } = { React, ReactDOM, ReactDOMClient, jsxRuntime, jsxDevRuntime };
  Object.defineProperty(globalThis, '__DEVICEFORGE_HOST_UI__', { configurable: true, writable: true, value: fixture });
  try {
    const paths = await imports();
    for (const [specifier, expected] of Object.entries({
      react: React,
      'react-dom': ReactDOM,
      'react-dom/client': ReactDOMClient,
      'react/jsx-runtime': jsxRuntime,
      'react/jsx-dev-runtime': jsxDevRuntime,
    })) {
      const path = paths[specifier];
      assert.ok(path, specifier);
      const actual: Record<string, unknown> = await import(pathToFileURL(resolve(root, 'public', path.slice(1))).href);
      assert.equal(actual['default'], expected, `${specifier} 的默认导出必须是宿主模块`);
      for (const [name, value] of Object.entries(expected)) {
        // React 私有内部字段及未写入公开类型的实验钩子不属于兼容承诺。
        if (name === 'default' || name === 'module.exports' || name.startsWith('_') || name === 'unstable_useCacheRefresh') continue;
        assert.equal(actual[name], value, `${specifier} 的 ${name} 必须复用宿主`);
      }
    }
    const reactPath = paths['react'];
    const domPath = paths['react-dom'];
    const devPath = paths['react/jsx-dev-runtime'];
    assert.ok(reactPath && domPath && devPath);
    // 通过 ESM 链接器验证命名导入；读对象属性不能捕获缺失导出的语法错误。
    const code = `import { useState } from ${JSON.stringify(pathToFileURL(resolve(root, 'public', reactPath.slice(1))).href)};
      import { createPortal } from ${JSON.stringify(pathToFileURL(resolve(root, 'public', domPath.slice(1))).href)};
      import { jsxDEV } from ${JSON.stringify(pathToFileURL(resolve(root, 'public', devPath.slice(1))).href)};
      export { useState, createPortal, jsxDEV };`;
    const linked: Record<string, unknown> = await import(`data:text/javascript,${encodeURIComponent(code)}`);
    assert.equal(linked['useState'], React.useState);
    assert.equal(linked['createPortal'], ReactDOM.createPortal);
    assert.equal(linked['jsxDEV'], jsxDevRuntime.jsxDEV);
  } finally {
    globalThis.__DEVICEFORGE_HOST_UI__ = previous;
  }
});
