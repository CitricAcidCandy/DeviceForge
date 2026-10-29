import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleInfo, WorkspaceSnapshot } from '../src/plugin-sdk/index.ts';
import {
  buildRouteCatalog, createRouteCatalog,
} from '../src/app/product/route-catalog.ts';
import type { RoutePageInput } from '../src/app/product/route-catalog.ts';
import {
  PRODUCT_ROUTES, localRouteKey, normalizeLocalRoute, parseProductRoute, pluginRoute, routeHash,
} from '../src/app/product/routes.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';

function page(overrides: Partial<RoutePageInput> = {}): RoutePageInput {
  return {
    id: 'sample.page', pluginId: 'sample', generation: 1, title: '插件页面',
    route: '/sample/tools/logs', workspaceId: 'sample.workspace', ...overrides,
  };
}
function workspace(pages: readonly RoutePageInput[]): Pick<WorkspaceSnapshot, 'catalog'> {
  return { catalog: { pages, views: [], workspaces: [] } };
}
function source<T>(initial: T) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next: T) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

test('独立插件嵌套页面和导航来自目录，不增加宿主固定路由清单', () => {
  const staticIds = PRODUCT_ROUTES.map((entry) => entry.id);
  const catalog = buildRouteCatalog([page({
    navigation: { group: '工具', order: 20, icon: 'terminal', description: '完整日志功能', hidden: true },
    operations: ['plugin.sample.logs.read', 'plugin.sample.logs.read'], taskPolicy: 'listed',
    viewId: 'sample.page',
  })]);
  assert.equal(catalog.entries[0]?.key, '/sample/tools/logs');
  assert.equal(catalog.entries[0]?.viewId, 'sample.page');
  assert.equal(catalog.entries[0]?.group, '工具');
  assert.equal(catalog.entries[0]?.hidden, true);
  assert.equal(catalog.entries[0]?.icon, 'terminal');
  assert.deepEqual(catalog.entries[0]?.operations, ['plugin.sample.logs.read']);
  assert.deepEqual(PRODUCT_ROUTES.map((entry) => entry.id), staticIds);
  assert.equal(parseProductRoute('#/sample/tools/logs', catalog.entries), '/sample/tools/logs');
  assert.equal(routeHash('/sample/tools/logs'), 'sample/tools/logs');
  assert.ok(Object.isFrozen(catalog.entries[0]?.operations));
});

test('旧宿主地址和plugin模块地址继续往返，新增路径保留完整嵌套', () => {
  for (const route of PRODUCT_ROUTES) {
    assert.equal(parseProductRoute(`#/${route.id}`), route.id);
    assert.equal(localRouteKey(`/${route.id}`), route.id);
  }
  const key = pluginRoute('device-app-catalog', 'catalog');
  assert.equal(parseProductRoute(`#/${routeHash(key)}`), key);
  assert.equal(parseProductRoute('#plugin/device-app-catalog/catalog'), key);
  assert.equal(parseProductRoute(key), key);
  assert.equal(parseProductRoute('#devices?tab=apps'), 'devices');
  assert.equal(parseProductRoute('#/不存在的页面'), 'devices');
  const catalog = buildRouteCatalog([page({ route: '/工具/日志' })]);
  assert.equal(parseProductRoute('#/工具/日志', catalog.entries), '/工具/日志');
  const root = buildRouteCatalog([page({ route: '/' })]);
  assert.equal(parseProductRoute(`#/${routeHash('/')}`, root.entries), '/');
});

test('未就绪或已卸载的插件地址可显式保留，目录不生成旧宿主业务回落', () => {
  assert.equal(parseProductRoute('#/later/tools', [], true), '/later/tools');
  assert.equal(parseProductRoute('#/later/tools'), 'devices');
  assert.deepEqual(buildRouteCatalog([]).entries, []);
  assert.equal(parseProductRoute('#/devices', [], true), 'devices');
});

test('本地地址拒绝外链、穿越、控制符、编码分隔符与二次编码', () => {
  for (const route of [
    'https://example.test', '//example.test', '/foo//bar', '/foo/../bar',
    '/foo/%2e%2e/bar', '/foo/%252e%252e/bar', '/foo/%2fbar', '/foo/%5cbar',
    '/foo\\bar', '/foo?bar', '/foo#bar', '/foo/%00', '/foo/%20', '/foo/%',
  ]) assert.equal(normalizeLocalRoute(route), null, route);
  assert.equal(normalizeLocalRoute('/sample/tools/'), '/sample/tools');
  assert.equal(normalizeLocalRoute('/sample/%E6%97%A5%E5%BF%97'), '/sample/%E6%97%A5%E5%BF%97');
  const invalid = buildRouteCatalog([page({ route: '//outside' })]);
  assert.equal(invalid.entries.length, 0);
  assert.equal(invalid.diagnostics[0]?.code, 'invalid_route');
});

test('同路径提供者冲突不按顺序抢占，过渡定义只在明确注入时使用', () => {
  const first = page();
  const second = page({ id: 'other.page', pluginId: 'other', title: '另一页面' });
  const conflict = buildRouteCatalog([first, second]);
  assert.equal(conflict.entries.length, 0);
  assert.equal(conflict.diagnostics[0]?.code, 'duplicate_route');
  assert.deepEqual(buildRouteCatalog([second, first]), conflict);
  const compatibility = page({ title: '兼容页面', generation: 0 });
  assert.equal(buildRouteCatalog([], [], [compatibility]).entries[0]?.source, 'compatibility');
  assert.equal(buildRouteCatalog([first], [], [compatibility]).entries[0]?.source, 'workspace');
  assert.equal(buildRouteCatalog([]).entries.length, 0);
});

test('旧模块页面与新工作区目录共存，统一键可发现路径冲突', () => {
  const module: ModuleInfo = { id: 'sample.module', pluginId: 'sample', generation: 1, title: '旧页面', route: 'tools' };
  const catalog = buildRouteCatalog([page()], [module]);
  assert.deepEqual(catalog.entries.map((entry) => entry.key).sort(), ['/sample/tools/logs', 'plugin:sample:tools']);
  const conflict = buildRouteCatalog([page({ route: '/plugin/sample/tools' })], [module]);
  assert.equal(conflict.entries.length, 0);
  assert.equal(conflict.diagnostics[0]?.route, 'plugin:sample:tools');
});

test('目录快照稳定、显式顺序与代次可更新，释放后不再订阅', () => {
  const input = source(workspace([page({ navigation: { order: 20 } })]));
  const modules = source<{ modules: readonly ModuleInfo[] }>({ modules: [] });
  const catalog = createRouteCatalog({ workspace: input, modules });
  const original = catalog.snapshot();
  let calls = 0;
  catalog.subscribe(() => { throw new Error('消费方失败'); });
  catalog.subscribe(() => { calls++; });
  input.publish(workspace([page({ navigation: { order: 20 } })]));
  assert.equal(catalog.snapshot(), original);
  assert.equal(calls, 0);
  input.publish(workspace([
    page({ generation: 2, navigation: { order: 20 } }),
    page({ id: 'sample.first', route: '/sample/first', navigation: { order: 1 } }),
  ]));
  assert.equal(calls, 1);
  assert.equal(catalog.snapshot().entries[0]?.id, 'sample.first');
  assert.equal(catalog.snapshot().entries[1]?.generation, 2);
  assert.equal(catalog.snapshot().revision, 1);
  catalog.dispose();
  catalog.dispose();
  assert.equal(input.listeners.size, 0);
  assert.equal(modules.listeners.size, 0);
  input.publish(workspace([]));
  assert.equal(calls, 1);
});

test('真实工作区热卸载撤销路由，新代恢复后旧释放不能删新目录', () => {
  const registry = createWorkspaceRegistry();
  const owner = new AbortController();
  const old = registry.access({ pluginId: 'sample', generation: 1, signal: owner.signal });
  const shell = registry.access({ pluginId: 'shell', generation: 1, signal: new AbortController().signal });
  const catalog = createRouteCatalog({ workspace: shell });
  const release = old.register({
    pages: [{ id: 'sample.page', title: '第一代', route: '/sample/live', workspaceId: 'sample.workspace' }],
    workspaces: [{ id: 'sample.workspace', title: '工作区' }],
  });
  assert.equal(catalog.snapshot().entries[0]?.generation, 1);
  owner.abort();
  assert.equal(catalog.snapshot().entries.length, 0);
  const next = registry.access({ pluginId: 'sample', generation: 2, signal: new AbortController().signal });
  next.register({
    pages: [{ id: 'sample.page', title: '第二代', route: '/sample/live', workspaceId: 'sample.workspace' }],
    workspaces: [{ id: 'sample.workspace', title: '工作区' }],
  });
  release();
  assert.equal(catalog.snapshot().entries[0]?.generation, 2);
  catalog.dispose();
  registry.dispose();
});

test('一项订阅回收失败仍释放另一来源，重复dispose不重放释放', () => {
  let workspaceReleases = 0;
  let moduleReleases = 0;
  const catalog = createRouteCatalog({
    workspace: {
      snapshot: () => workspace([]),
      subscribe: () => () => { workspaceReleases++; },
    },
    modules: {
      snapshot: () => ({ modules: [] }),
      subscribe: () => () => { moduleReleases++; throw new Error('模块订阅回收失败'); },
    },
  });
  assert.throws(() => catalog.dispose(), AggregateError);
  assert.equal(workspaceReleases, 1);
  assert.equal(moduleReleases, 1);
  catalog.dispose();
  assert.equal(moduleReleases, 1);
});
