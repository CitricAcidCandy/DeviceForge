import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRouteCatalog } from '../src/app/product/route-catalog.ts';
import type { RoutePageInput } from '../src/app/product/route-catalog.ts';
import {
  createTaskRouteMatcher, taskBelongsToRoute,
} from '../src/app/product/task-scope.ts';
import type { TaskRouteContribution } from '../src/app/product/task-scope.ts';

function page(overrides: Partial<RoutePageInput> = {}): RoutePageInput {
  return {
    id: 'sample.page', pluginId: 'sample', generation: 1, title: '工具',
    route: '/sample/tools', workspaceId: null, operations: ['plugin.sample.inspect'],
    ...overrides,
  };
}

test('插件贡献操作目录就是任务归属来源，不依赖宿主业务操作硬表', () => {
  const routes = buildRouteCatalog([page()]).entries;
  assert.equal(taskBelongsToRoute('plugin.sample.inspect', '/sample/tools', undefined, routes), true);
  assert.equal(taskBelongsToRoute('plugin.sample.other', '/sample/tools', undefined, routes), false);
  assert.equal(taskBelongsToRoute('plugin.sample.inspect', 'devices', undefined, routes), false);
  assert.equal(taskBelongsToRoute('plugin.frida.server.run', 'frida'), false);
});

test('all由贡献声明，任意页面都能使用；tasks名字本身没有特殊权限', () => {
  const routes = buildRouteCatalog([
    page({ taskPolicy: 'all' }),
    page({ id: 'sample.tasks', route: '/tasks', operations: [] }),
  ]).entries;
  assert.equal(taskBelongsToRoute('anything', '/sample/tools', undefined, routes), true);
  assert.equal(taskBelongsToRoute('anything', 'tasks', undefined, routes), false);
  assert.equal(taskBelongsToRoute('anything', 'tasks'), false);
});

test('匹配器读取最新目录，卸载和新代恢复不保留旧操作归属', () => {
  let routes: readonly TaskRouteContribution[] = buildRouteCatalog([page()]).entries;
  const matches = createTaskRouteMatcher(() => routes);
  assert.equal(matches('plugin.sample.inspect', '/sample/tools'), true);
  routes = [];
  assert.equal(matches('plugin.sample.inspect', '/sample/tools'), false);
  routes = buildRouteCatalog([page({ generation: 2, operations: ['plugin.sample.changed'] })]).entries;
  assert.equal(matches('plugin.sample.inspect', '/sample/tools'), false);
  assert.equal(matches('plugin.sample.changed', '/sample/tools'), true);
});

test('旧设备能力集合仅在调用方明确注入时保留，不扩大至其他路由', () => {
  const operations = new Set(['plugin.provider.discover']);
  assert.equal(taskBelongsToRoute('plugin.provider.discover', 'devices', operations), true);
  assert.equal(taskBelongsToRoute('plugin.provider.discover', '/sample/tools', operations), false);
  assert.equal(taskBelongsToRoute('plugin.provider.discover', 'devices'), false);
});

test('过渡归属表允许显式注入，但未注入时不隐式补回业务目录', () => {
  const compatibility: readonly TaskRouteContribution[] = [
    { key: 'frida', operations: ['plugin.frida.server.run'] },
    { key: 'tasks', taskPolicy: 'all' },
  ];
  assert.equal(taskBelongsToRoute('plugin.frida.server.run', 'frida', undefined, compatibility), true);
  assert.equal(taskBelongsToRoute('other', 'frida', undefined, compatibility), false);
  assert.equal(taskBelongsToRoute('other', 'tasks', undefined, compatibility), true);
  assert.equal(taskBelongsToRoute('other', 'tasks'), false);
});

test('冲突路由没有有效贡献，不误把任何一个冲突提供者的任务并入页面', () => {
  const routes = buildRouteCatalog([
    page(),
    page({ id: 'other.page', pluginId: 'other', operations: ['plugin.other.write'], taskPolicy: 'all' }),
  ]).entries;
  assert.equal(taskBelongsToRoute('plugin.sample.inspect', '/sample/tools', undefined, routes), false);
  assert.equal(taskBelongsToRoute('plugin.other.write', '/sample/tools', undefined, routes), false);
});
