import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import type { Component } from 'svelte';

function componentModule(value: unknown): value is { default: Component } {
  return value !== null && typeof value === 'object' && 'default' in value && typeof value.default === 'function';
}
function rendererModule(value: unknown): value is { render: typeof import('svelte/server').render } {
  return value !== null && typeof value === 'object' && 'render' in value && typeof value.render === 'function';
}

test('基础外壳显示产品名称和开发阶段', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/app/App.svelte');
    const renderer: unknown = await server.ssrLoadModule('svelte/server');
    assert.ok(componentModule(loaded), 'Svelte 外壳应导出组件函数');
    assert.ok(rendererModule(renderer), 'Svelte 服务端模块应导出渲染函数');
    const result = renderer.render(loaded.default);
    assert.match(result.body, /DeviceForge/);
    assert.match(result.body, /设备工坊/);
    assert.match(result.body, /开发进度/);
  } finally {
    await server.close();
  }
});

