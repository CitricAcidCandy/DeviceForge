import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as ts from 'typescript';
import type { ProductRoute } from '../src/app/product/route-address.ts';
import {
  isPluginRoute, localRouteKey, normalizeLocalRoute, parseProductRoute, pluginRoute, routeHash, splitPluginRoute,
} from '../src/app/product/route-address.ts';
import { buildRouteCatalog, createRouteCatalog } from '../src/app/product/route-catalog.ts';
import { LEGACY_ROUTE_DEFINITIONS } from '../src/app/product/legacy-route-definitions.ts';
import {
  localRouteKey as legacyLocalRouteKey, parseProductRoute as parseLegacyRoute, PRODUCT_ROUTES,
} from '../src/app/product/routes.ts';
import { HOST_SLOTS, isKnownSlot, routeSlotId, slotModes } from '../src/app/product/slots.ts';
import { createTaskRouteMatcher } from '../src/app/product/task-scope.ts';
import type { TaskRouteContribution } from '../src/app/product/task-scope.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';

test('任意新路径可直接解析和登记，不依赖固定业务清单且未知地址保持可恢复', () => {
  const future: ProductRoute = 'future-tool';
  assert.equal(localRouteKey('/future-tool'), future);
  assert.equal(parseProductRoute('#/future-tool'), future);
  assert.equal(parseProductRoute('#/future/tools/logs?filter=one'), '/future/tools/logs');
  assert.equal(parseProductRoute('#/future/tools/logs', [], false), '/');
  assert.equal(parseProductRoute('#/future/tools/logs', [], true), '/future/tools/logs');
  assert.equal(parseProductRoute('#/'), '/');
  assert.equal(parseProductRoute('#/bad/%2froute'), '/');
  const before = LEGACY_ROUTE_DEFINITIONS.map((entry) => entry.id);
  const catalog = buildRouteCatalog([{
    id: 'new.page', pluginId: 'new', generation: 1, title: '未来功能',
    route: '/future-tool', workspaceId: 'new.workspace',
  }, {
    id: 'new.nested', pluginId: 'new', generation: 1, title: '嵌套功能',
    route: '/future/tools/logs', workspaceId: 'new.workspace',
  }]);
  assert.deepEqual(catalog.entries.map((entry) => entry.key).sort(), ['/future/tools/logs', future]);
  for (const entry of catalog.entries) {
    assert.equal(parseProductRoute(`#/${routeHash(entry.key)}`, catalog.entries), entry.key);
    assert.equal(parseLegacyRoute(`#/${routeHash(entry.key)}`, catalog.entries), entry.key);
  }
  assert.equal(parseProductRoute('#/future-tool', [{ key: '/future-tool' }], false), '/future-tool');
  assert.deepEqual(LEGACY_ROUTE_DEFINITIONS.map((entry) => entry.id), before);
});

test('旧11地址及派生插件地址继续往返，旧UI默认回落不改变', () => {
  assert.equal(LEGACY_ROUTE_DEFINITIONS.length, 11);
  assert.deepEqual(PRODUCT_ROUTES.map(({ icon: _icon, ...definition }) => definition), LEGACY_ROUTE_DEFINITIONS);
  for (const { id } of LEGACY_ROUTE_DEFINITIONS) {
    assert.equal(parseProductRoute(`#/${id}`), id);
    assert.equal(parseLegacyRoute(`#/${id}`), id);
    assert.equal(legacyLocalRouteKey(`/${id}`), id);
    assert.equal(routeSlotId(id), `route.${id}`);
  }
  assert.equal(parseLegacyRoute('#/future-tool'), 'devices');
  assert.equal(parseLegacyRoute('#/future/tools/logs'), 'devices');
  assert.equal(parseLegacyRoute('#/'), 'devices');
  assert.equal(legacyLocalRouteKey('/future-tool'), '/future-tool');
  assert.equal(parseLegacyRoute('#/devices?tab=apps'), 'devices');
  for (const length of [1, 65, 100]) {
    const pluginId = `p${'a'.repeat(length - 1)}`, key = pluginRoute(pluginId, '/catalog');
    assert.ok(isPluginRoute(key));
    assert.deepEqual(splitPluginRoute(key), { pluginId, page: 'catalog' });
    assert.equal(parseProductRoute(`#/${routeHash(key)}`), key);
    assert.equal(parseLegacyRoute(`#/${routeHash(key)}`), key);
    assert.equal(localRouteKey(`/plugin/${pluginId}/catalog`), key);
    assert.equal(routeSlotId(key), `page.${pluginId}.catalog`);
  }
});

test('本地路径校验及旧槽位模式保持，动态业务不向旧静态槽位清单登记', () => {
  for (const path of ['//outside.test', '/a/../b', '/a/%252f/b', '/a/%2f/b', '/a\\b', '/a?b', '/a/%00'])
    assert.equal(normalizeLocalRoute(path), null);
  assert.equal(normalizeLocalRoute('/工具/日志/'), '/工具/日志');
  assert.deepEqual(slotModes('route.marketplace'), ['append']);
  assert.deepEqual(slotModes('route.settings'), ['append']);
  assert.deepEqual(slotModes('devices.apps'), ['append', 'replace']);
  assert.deepEqual(slotModes('page.example.logs'), ['replace']);
  assert.equal(isKnownSlot('route.future-tool'), false);
  assert.equal(HOST_SLOTS.length, 14);
});

test('提供者卸载保留地址，新代路由恢复且旧释放不能撤新贡献', () => {
  const registry = createWorkspaceRegistry(), owner = new AbortController();
  const shell = registry.access({ pluginId: 'shell', generation: 1, signal: new AbortController().signal });
  const catalog = createRouteCatalog({ workspace: shell });
  const current = parseProductRoute('#/future-tool');
  const old = registry.access({ pluginId: 'future', generation: 1, signal: owner.signal }).register({
    pages: [{ id: 'future.page', title: '第一代', route: '/future-tool', workspaceId: 'future.workspace' }],
    workspaces: [{ id: 'future.workspace', title: '未来工作区' }],
  });
  try {
    assert.equal(catalog.snapshot().entries[0]?.key, current);
    owner.abort();
    assert.equal(catalog.snapshot().entries.length, 0);
    assert.equal(parseProductRoute(`#/${routeHash(current)}`, catalog.snapshot().entries), current);
    registry.access({ pluginId: 'future', generation: 2, signal: new AbortController().signal }).register({
      pages: [{ id: 'future.page', title: '第二代', route: '/future-tool', workspaceId: 'future.workspace' }],
      workspaces: [{ id: 'future.workspace', title: '未来工作区' }],
    });
    old();
    assert.equal(catalog.snapshot().entries[0]?.generation, 2);
    assert.equal(catalog.snapshot().entries[0]?.key, current);
  } finally {
    catalog.dispose(); registry.dispose();
  }
});

test('任务归属只读当代贡献，旧设备操作集合仍须显式传入', () => {
  let entries: readonly TaskRouteContribution[] = [{ key: 'future-tool', operations: ['future.inspect'] }];
  const matcher = createTaskRouteMatcher(() => entries);
  assert.equal(matcher('future.inspect', 'future-tool'), true);
  entries = [];
  assert.equal(matcher('future.inspect', 'future-tool'), false);
  assert.equal(matcher('device.explicit', 'devices'), false);
  assert.equal(matcher('device.explicit', 'devices', new Set(['device.explicit'])), true);
  assert.equal(matcher('device.explicit', 'future-tool', new Set(['device.explicit'])), false);
});

test('正常地址与目录不加载旧业务metadata或Lucide，旧槽位只读无图标兼容定义', async () => {
  async function runtimeImports(path: string): Promise<readonly string[]> {
    const location = new URL(`../src/app/product/${path}`, import.meta.url);
    const source = ts.createSourceFile(fileURLToPath(location), await readFile(location, 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const dependencies: string[] = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.importClause?.isTypeOnly) continue;
      dependencies.push(statement.moduleSpecifier.text);
    }
    return dependencies;
  }
  assert.deepEqual(await runtimeImports('route-address.ts'), ['../../plugin-sdk/slots.ts']);
  assert.deepEqual(await runtimeImports('route-catalog.ts'), ['./route-address.ts']);
  assert.deepEqual(await runtimeImports('legacy-route-definitions.ts'), []);
  const slots = await runtimeImports('slots.ts');
  assert.ok(slots.includes('./legacy-route-definitions.ts'));
  assert.ok(slots.includes('./route-address.ts'));
  assert.ok(slots.every((path) => path !== './routes.ts' && !path.includes('lucide')));
});
