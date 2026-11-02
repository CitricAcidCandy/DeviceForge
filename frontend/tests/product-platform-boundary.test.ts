import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const parser = registerCompositionStartupImports();
after(parser.dispose);

test('正常入口只导入纯平台产品装配，不把旧集中工厂作为根依赖', async () => {
  const main = await readFile(new URL('../src/app/main.ts', import.meta.url), 'utf8');
  assert.ok(/import\s*\{\s*createProductPlatformServices\s*\}\s*from\s*['"]\.\/product\/platform-services\.ts['"]/.test(main),
    '正常 main 仍未切换纯平台装配');
  assert.equal(/from\s*['"]\.\/product\/services\.ts['"]/.test(main), false, '正常入口不能读取旧产品兼容工厂');
});

test('纯平台产品装配没有旧业务访问器，构造与关闭不联网', async () => {
  const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');
  let requests = 0;
  const core = createProductPlatformServices({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { requests++; throw new Error('纯平台装配不应联网'); },
  });
  try {
    for (const key of ['frida', 'automation', 'aiAssistant', 'settings', 'sessions', 'dex', 'msgpack', 'profile'])
      assert.equal(Object.hasOwn(core, key), false, `纯平台不应暴露旧业务 ${key}`);
    for (const key of ['aiSdk', 'aiSdkStreaming', 'performance'])
      assert.equal(Object.hasOwn(core.runtime, key), false, `纯运行时不应暴露旧业务 ${key}`);
    assert.equal(requests, 0);
    const closing = core.dispose();
    assert.equal(core.dispose(), closing);
    await closing;
    assert.equal(requests, 0);
  } finally { await core.dispose(); }
});

test('显式产品兼容适配按需创建，释放不关闭平台或影响新适配', async () => {
  const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');
  const { createLegacyProductAdapter } = await import('../src/app/product/legacy-services.ts');
  let requests = 0;
  const core = createProductPlatformServices({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { requests++; throw new Error('兼容适配构造不应联网'); },
  });
  const first = createLegacyProductAdapter(core);
  try {
    const model = first.services.automation;
    assert.equal(first.services.automation, model);
    const closing = first.dispose();
    assert.equal(first.dispose(), closing);
    await closing;
    assert.equal(core.runtime.host.signal.aborted, false);
    assert.throws(() => first.services.automation, /已关闭/);
    const next = createLegacyProductAdapter(core);
    try {
      assert.notEqual(next.services.automation, model);
      assert.equal(requests, 0);
    } finally { await next.dispose(); }
  } finally { await first.dispose(); await core.dispose(); }
});

test('平台关闭回收仍归属的兼容适配，关闭后不能重新取得旧模型', async () => {
  const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');
  const { createLegacyProductAdapter } = await import('../src/app/product/legacy-services.ts');
  const core = createProductPlatformServices({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { throw new Error('关闭适配不能隐式发起业务'); },
  });
  const legacy = createLegacyProductAdapter(core);
  legacy.services.frida;
  await core.dispose();
  assert.throws(() => legacy.services.frida, /已关闭/);
  assert.throws(() => createLegacyProductAdapter(core));
  await legacy.dispose();
});
