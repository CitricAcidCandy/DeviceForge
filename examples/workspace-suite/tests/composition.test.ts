import test from 'node:test';
import assert from 'node:assert/strict';
import createSuite from '../browser/index.ts';
import { attachView } from '../browser/workspace.ts';
import { resolveFilesView } from '../browser/proxy-view.ts';
import { hostFixture } from './host-fixture.ts';
import type { JsonValue } from '@deviceforge/plugin-sdk';

test('身份工厂登记跨页自动贡献及自有能力，消费方未出现时不直接改他人布局或发业务', async () => {
  const f = hostFixture(), plugin = createSuite({ id: f.prefix, version: '1', apiVersion: 2 });
  const original = { version: 1, root: { kind: 'view', instanceId: 'devices.original' },
    floating: [], overlays: [] } satisfies import('@deviceforge/plugin-sdk').WorkspaceLayout;
  f.layouts.set('devices.workspace', structuredClone(original));
  assert.ok(plugin.activate);
  await plugin.activate(f.context);
  assert.deepEqual(f.layouts.get('devices.workspace'), original);
  assert.deepEqual(f.counts, { businessCalls: 0, mounted: 0 });
  assert.equal(f.points[0]?.id, `${f.prefix}.tools`);
  assert.equal(f.sources[0]?.persistence, 'memory');
  assert.equal(f.sources[0]?.readOnly, false);
  assert.equal(f.ui.catalog().pages[0]?.route, '/workspace-suite');
  assert.deepEqual(f.opened.map((item) => item.instanceId), [`${f.prefix}.main.default`]);
  assert.deepEqual(f.pointContributions.map((entry) => entry.point), [
    { id: 'deviceforge_devices.tools', version: '1' }, { id: 'deviceforge_files.tools', version: '1' },
  ]);
  assert.ok(f.pointContributions.every((entry) => entry.mode === 'append' &&
    entry.data !== null && typeof entry.data === 'object' && !Array.isArray(entry.data) && entry.data.viewId === `${f.prefix}.main`));
  const entries = f.contributions.flatMap((item) => item.services ?? []);
  const read = entries.find((item) => item.id === `${f.prefix}.message.read`);
  const write = entries.find((item) => item.id === `${f.prefix}.message.write`);
  assert.ok(read && write);
  const initial = await read.invoke({}, f.context, f.context.signal);
  assert.ok(initial.data && typeof initial.data === 'object' && !Array.isArray(initial.data));
  const revision = initial.data.revision;
  assert.equal(typeof revision, 'string');
  if (typeof revision !== 'string') throw new Error('修订缺失');
  const draft = { message: '独立编辑' };
  await write.invoke({ value: draft, expectedRevision: revision }, f.context, f.context.signal);
  await assert.rejects(write.invoke({ value: draft, expectedRevision: revision }, f.context, f.context.signal));
  assert.deepEqual(draft, { message: '独立编辑' });
  await f.dispose();
});

test('显式追加只改所选设备或文件工作区，目标必须明确，重名或未知工作区不覆盖', () => {
  const f = hostFixture(), workspaceId = 'chosen.workspace';
  f.setCatalog({
    workspaces: [{ id: workspaceId, title: '所选设备', pluginId: 'devices', generation: 1 }],
    pages: [{ id: 'devices.page', title: '设备', pluginId: 'devices', generation: 1,
      route: '/devices', workspaceId }], views: [],
  });
  const original = { version: 1, root: { kind: 'view', instanceId: 'devices.original' },
    floating: [], overlays: [] } satisfies import('@deviceforge/plugin-sdk').WorkspaceLayout;
  f.layouts.set(workspaceId, structuredClone(original));
  const target: JsonValue = { kind: 'device', reference: {
    providerId: 'provider', generation: 'device-generation', localId: 'local-device',
  } };
  assert.throws(() => attachView(f.context, f.prefix,
    { workspaceId, instanceId: `${f.prefix}.one`, target: null }), /完整设备引用/);
  assert.throws(() => attachView(f.context, f.prefix,
    { workspaceId: 'unknown', instanceId: `${f.prefix}.one`, target }), /不存在/);
  assert.deepEqual(f.layouts.get(workspaceId), original);
  const result = attachView(f.context, f.prefix, { workspaceId, instanceId: `${f.prefix}.one`, target });
  assert.deepEqual(result, { workspaceId, instanceId: `${f.prefix}.one` });
  assert.deepEqual(f.instances.get(`${f.prefix}.one`)?.target, target);
  assert.throws(() => attachView(f.context, f.prefix,
    { workspaceId, instanceId: `${f.prefix}.one`, target }), /不会覆盖/);
  const after = f.layouts.get(workspaceId);
  assert.equal(after?.root?.kind, 'tabs');
  assert.deepEqual(original.root, { kind: 'view', instanceId: 'devices.original' });
});

test('委托视图缺失或有歧义时明确失败，只选公开files.browser唯一提供者，不猜已有实例', () => {
  const f = hostFixture();
  assert.throws(() => resolveFilesView(f.ui, f.prefix), /缺失或存在多个/);
  assert.equal(f.counts.mounted, 0);
  const view = { id: 'public_files.browser', pluginId: 'public_files', generation: 1,
    title: '文件', provides: ['files.browser'] };
  f.setCatalog({ pages: [], workspaces: [], views: [view, { ...view, id: 'other.browser', pluginId: 'other' }] });
  assert.throws(() => resolveFilesView(f.ui, f.prefix), /缺失或存在多个/);
  f.setCatalog({ pages: [], workspaces: [], views: [view] });
  assert.equal(resolveFilesView(f.ui, f.prefix).id, 'public_files.browser');
  assert.equal(f.counts.mounted, 0);
  assert.deepEqual(f.opened, []);
});
