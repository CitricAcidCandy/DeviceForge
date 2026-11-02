import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';

const parser = registerCompositionStartupImports();
after(parser.dispose);
const { createLegacyProductBusiness } = await import('../src/app/product/legacy-business.ts');
const { createProductServices } = await import('../src/app/product/services.ts');

test('真实兼容层只创建被读取的旧业务，读取 Frida 不构造终端、AI 或投屏对象', async () => {
  let requests = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { requests++; throw new Error('按需业务构造不应联网'); },
  });
  const legacy = createLegacyProductBusiness(runtime);
  try {
    assert.deepEqual(legacy.snapshot(), []);
    const first = legacy.frida;
    assert.equal(legacy.frida, first);
    assert.deepEqual(legacy.snapshot(), ['frida']);
    assert.equal(requests, 0);
    await legacy.dispose();
    assert.throws(() => legacy.sessions, /已关闭/);
    assert.equal(requests, 0);
  } finally { await legacy.dispose(); await runtime.dispose(); }
});

test('真实产品启动与关闭不创建未读取的兼容业务，旧访问器仍保持原实例', async () => {
  let requests = 0;
  const services = createProductServices({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { requests++; throw new Error('静态产品装配不应联网'); },
  });
  try {
    assert.equal(typeof Object.getOwnPropertyDescriptor(services, 'frida')?.get, 'function');
    assert.equal(services.automation, services.automation);
    assert.equal(requests, 0);
    const closing = services.dispose();
    assert.equal(services.dispose(), closing);
    await closing;
    assert.throws(() => services.aiAssistant, /已关闭/);
    assert.equal(requests, 0);
  } finally { await services.dispose(); }
});
