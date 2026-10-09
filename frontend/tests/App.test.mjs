import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';


test('基础外壳显示产品名称和开发阶段', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { default: App } = await server.ssrLoadModule('/src/app/App.svelte');
    const { render } = await server.ssrLoadModule('svelte/server');
    const result = render(App);
    assert.match(result.body, /DeviceForge/);
    assert.match(result.body, /设备工坊/);
    assert.match(result.body, /开发进度/);
  } finally {
    await server.close();
  }
});

