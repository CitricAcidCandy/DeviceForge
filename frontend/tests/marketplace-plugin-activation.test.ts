import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Dispose, HostContext, ServiceContribution, ServiceRef, WorkspaceContributions,
} from '@deviceforge/plugin-sdk';
import { createMarketplacePlugin } from '../plugins/marketplace/src/index.ts';
import { marketContext } from '../plugins/marketplace/tests/context.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';

test('市场激活不联网也不挂业务视图，管理依赖齐备后才登记真实工作区', async (unit) => {
  let requests = 0, stopped = 0;
  unit.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('激活不应访问市场'); });
  const base = marketContext({
    request: async () => { requests++; throw new Error('激活不应读取管理目录'); },
  });
  const extensions = base.extensions, services = base.services;
  assert.ok(extensions); assert.ok(services);
  const registry = createWorkspaceRegistry(), lifetime = new AbortController();
  const disposers: Dispose[] = [], preferences: ServiceContribution[] = [];
  const feature: {
    id: string | null;
    required: readonly ServiceRef[];
    setup: ((context: HostContext) => void | Dispose | Promise<void | Dispose>) | null;
  } = { id: null, required: [], setup: null };
  const context: HostContext = {
    ...base,
    ui: registry.access({ pluginId: 'deviceforge_marketplace', generation: 1, signal: base.signal }),
    onDispose(dispose) { disposers.push(dispose); return dispose; },
    extensions: { ...extensions, register(value) { preferences.push(...value.services ?? []); return () => undefined; } },
    services: { ...services, whenAvailable(id, required, setup) {
      feature.id = id; feature.required = required; feature.setup = setup;
      return () => { stopped++; lifetime.abort(); };
    } },
  };
  await createMarketplacePlugin({ id: 'deviceforge_marketplace', version: '0.1.0', apiVersion: 2 }).activate?.(context);
  assert.equal(requests, 0);
  assert.equal(registry.catalog().pages.length, 0);
  assert.equal(feature.id, 'deviceforge_marketplace.workbench');
  assert.deepEqual(feature.required, [
    { id: 'host.browser-plugins', version: '1' }, { id: 'host.ui-directory', version: '1' },
  ]);
  const address = preferences[0]; assert.ok(address);
  await address.invoke({ action: 'set', url: 'http://selected-market.example' }, context, base.signal);
  const registered: WorkspaceContributions[] = [];
  const ui = registry.access({ pluginId: 'deviceforge_marketplace', generation: 1, signal: lifetime.signal });
  assert.ok(feature.setup);
  await feature.setup({
    ...context, signal: lifetime.signal,
    ui: { ...ui, register(value) { registered.push(value); return ui.register(value); } },
  });
  assert.equal(requests, 0);
  assert.equal(registry.catalog().pages[0]?.route, '/marketplace');
  assert.equal(registry.catalog().pages[0]?.navigation?.order, 100);
  assert.equal(registry.snapshot().instances.length, 1);
  assert.equal(typeof registered[0]?.views?.[0]?.mount, 'function');
  lifetime.abort();
  assert.equal(registry.catalog().pages.length, 0);
  assert.equal(registry.snapshot().layouts.length, 1);
  assert.deepEqual((await address.invoke({ action: 'get' }, context, base.signal)).data,
    { url: 'http://selected-market.example' });
  for (const dispose of disposers.reverse()) await dispose();
  assert.equal(stopped, 1);
  registry.dispose();
});

test('旧版宿主只有工作区时保留地址服务，不绕过缺失的管理依赖', async () => {
  const { services: _services, ...base } = marketContext();
  const extensions = base.extensions; assert.ok(extensions);
  const registry = createWorkspaceRegistry(), registered: ServiceContribution[] = [], disposers: Dispose[] = [];
  const context: HostContext = {
    ...base, ui: registry.access({ pluginId: 'deviceforge_marketplace', generation: 1, signal: base.signal }),
    onDispose(dispose) { disposers.push(dispose); return dispose; },
    extensions: { ...extensions, register(value) { registered.push(...value.services ?? []); return () => undefined; } },
  };
  await createMarketplacePlugin({ id: 'deviceforge_marketplace', version: '0.1.0' }).activate?.(context);
  assert.equal(registered[0]?.id, 'deviceforge_marketplace.preferences');
  assert.equal(registry.catalog().pages.length, 0);
  for (const dispose of disposers) await dispose();
  registry.dispose();
});
