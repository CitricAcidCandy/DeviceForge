import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createWorkspaceStorage } from '../src/app/workspace-storage.ts';
import type { WorkspaceStorageLike } from '../src/app/workspace-storage.ts';
import type { WorkspaceLayout } from '../src/plugin-sdk/workspace.ts';

const empty: WorkspaceLayout = { version: 1, root: null, floating: [], overlays: [] };
function fixture(raw: string | null = null) {
  let saved = raw;
  let reads = 0;
  const writes: string[] = [];
  let denied = false;
  const storage: WorkspaceStorageLike = {
    getItem(key) {
      assert.equal(key, 'deviceforge.workspace.test');
      reads++;
      if (denied) throw new Error('访问拒绝，敏感内容不应外显');
      return saved;
    },
    setItem(key, value) {
      assert.equal(key, 'deviceforge.workspace.test');
      if (denied) throw new Error('访问拒绝，敏感内容不应外显');
      writes.push(value);
      saved = value;
    },
    removeItem() { throw new Error('本适配不自动删除源草稿'); },
  };
  return { storage, writes, read: () => saved, reads: () => reads, deny: (value: boolean) => { denied = value; }, external: (value: string | null) => { saved = value; } };
}
function ui(registry: ReturnType<typeof createWorkspaceRegistry>) {
  return registry.access({ pluginId: 'plugin', generation: 1, signal: new AbortController().signal });
}

test('空源不主动写入，业务布局变化同步保存，重复目录通知不产生写风暴', () => {
  const registry = createWorkspaceRegistry();
  const source = fixture();
  const adapter = createWorkspaceStorage({ registry, storage: source.storage, key: 'deviceforge.workspace.test' });
  assert.equal(adapter.snapshot(), adapter.snapshot());
  assert.equal(adapter.snapshot().state, 'ready');
  assert.equal(source.writes.length, 0);
  const access = ui(registry);
  access.writeLayout('plugin.work', empty);
  assert.equal(source.writes.length, 1);
  access.register({ workspaces: [{ id: 'plugin.work', title: '工作区' }] });
  access.writeLayout('plugin.work', empty);
  assert.equal(source.writes.length, 1);
  access.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: null, target: { file: 'draft' } });
  assert.equal(source.writes.length, 2);
  adapter.dispose();
  access.setVisible('plugin.a', false);
  assert.equal(source.writes.length, 2);
  registry.dispose();
});

test('恢复合法 JSON 不自动挂载、打开或重写来源，显式重接不丢草稿', () => {
  const original = createWorkspaceRegistry();
  const first = ui(original);
  first.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' }, target: { file: 'draft' } });
  first.writeLayout('plugin.work', { ...empty, root: { kind: 'view', instanceId: 'plugin.a' } });
  const raw = JSON.stringify(original.save(), null, 2);
  original.dispose();
  const registry = createWorkspaceRegistry();
  const source = fixture(raw);
  const adapter = createWorkspaceStorage({ registry, storage: source.storage, key: 'deviceforge.workspace.test' });
  const access = ui(registry);
  let mounted = 0;
  access.register({ views: [{ id: 'plugin.view', title: '视图', mount: async () => { mounted++; return () => {}; } }] });
  assert.equal(adapter.snapshot().source, 'restored');
  assert.equal(access.snapshot().instances[0]?.reason, 'owner_inactive');
  assert.equal(mounted, 0);
  assert.equal(source.writes.length, 0);
  access.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' } });
  assert.deepEqual(access.snapshot().instances[0]?.target, { file: 'draft' });
  assert.equal(source.writes.length, 0);
  adapter.dispose();
  registry.dispose();
});

test('损坏源保留且不封锁工作区操作，只由 saveCurrent 显式覆盖', () => {
  const registry = createWorkspaceRegistry();
  const source = fixture('{"broken":');
  const adapter = createWorkspaceStorage({ registry, storage: source.storage, key: 'deviceforge.workspace.test' });
  assert.equal(adapter.snapshot().state, 'blocked');
  assert.equal(adapter.snapshot().lastError?.code, 'invalid_source');
  ui(registry).writeLayout('plugin.work', empty);
  assert.equal(source.read(), '{"broken":');
  assert.equal(source.writes.length, 0);
  assert.equal(adapter.snapshot().pending, true);
  assert.equal(adapter.saveCurrent(), true);
  assert.equal(adapter.snapshot().state, 'ready');
  assert.equal(adapter.snapshot().lastError, null);
  assert.equal(source.writes.length, 1);
  adapter.dispose();
  registry.dispose();
});

test('存储读取拒绝、写入拒绝均不崩根，失败后只显式重试，不泄露底层错误', () => {
  const registry = createWorkspaceRegistry();
  const source = fixture();
  source.deny(true);
  const adapter = createWorkspaceStorage({ registry, storage: source.storage, key: 'deviceforge.workspace.test' });
  const access = ui(registry);
  access.writeLayout('plugin.work', empty);
  assert.equal(adapter.snapshot().source, 'unavailable');
  assert.equal(adapter.snapshot().lastError?.code, 'read_failed');
  assert.equal(JSON.stringify(adapter.snapshot()).includes('敏感'), false);
  source.deny(false);
  assert.equal(adapter.saveCurrent(), true);
  assert.equal(source.writes.length, 1);
  source.deny(true);
  access.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: null });
  assert.equal(adapter.snapshot().state, 'save_failed');
  assert.equal(adapter.snapshot().lastError?.code, 'write_failed');
  source.deny(false);
  access.setTarget('plugin.a', { revision: 2 });
  assert.equal(source.writes.length, 1);
  assert.equal(adapter.saveCurrent(), true);
  assert.equal(source.writes.length, 2);
  assert.equal(adapter.snapshot().pending, false);
  adapter.dispose();
  registry.dispose();
});

test('重新读取损坏或超限来源保留当前模型，修正来源后显式重读恢复', () => {
  const registry = createWorkspaceRegistry();
  const access = ui(registry);
  access.writeLayout('plugin.work', empty);
  const before = registry.snapshot();
  const source = fixture('x'.repeat(2049));
  const adapter = createWorkspaceStorage({ registry, storage: source.storage, key: 'deviceforge.workspace.test', maxBytes: 2048 });
  assert.equal(adapter.snapshot().lastError?.code, 'source_too_large');
  assert.equal(registry.snapshot(), before);
  source.external(JSON.stringify({ version: 1, instances: [], layouts: [{ workspaceId: 'plugin.bad', layout: { version: 2 } }] }));
  assert.equal(adapter.retryRead(), false);
  assert.equal(registry.snapshot(), before);
  source.external(JSON.stringify({ version: 1, instances: [], layouts: [] }));
  assert.equal(adapter.retryRead(), true);
  assert.equal(adapter.snapshot().state, 'ready');
  assert.equal(registry.snapshot().layouts.length, 0);
  assert.equal(source.writes.length, 0);
  adapter.dispose();
  registry.dispose();
});

test('UTF8字节上限约束写入，超限保留旧值并允许后续显式保存', () => {
  const registry = createWorkspaceRegistry();
  const source = fixture();
  const adapter = createWorkspaceStorage({ registry, storage: source.storage, key: 'deviceforge.workspace.test', maxBytes: 512 });
  const access = ui(registry);
  access.writeLayout('plugin.work', empty);
  const old = source.read();
  access.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: null, target: { draft: '中'.repeat(110) } });
  assert.equal(adapter.snapshot().lastError?.code, 'snapshot_too_large');
  assert.equal(source.read(), old);
  access.setTarget('plugin.a', null);
  assert.equal(source.read(), old);
  assert.equal(adapter.saveCurrent(), true);
  assert.equal(adapter.snapshot().lastError, null);
  adapter.dispose();
  registry.dispose();
});

test('信号关闭撤销订阅，错误回调隔离，首次已取消信号不读写存储', () => {
  const registry = createWorkspaceRegistry();
  const source = fixture();
  const controller = new AbortController();
  const adapter = createWorkspaceStorage({ registry, storage: source.storage, key: 'deviceforge.workspace.test', signal: controller.signal });
  adapter.subscribe(() => { throw new Error('消费方失败'); });
  let notifications = 0;
  adapter.subscribe(() => { notifications++; });
  source.deny(true);
  ui(registry).writeLayout('plugin.work', empty);
  assert.equal(notifications, 1);
  controller.abort();
  assert.equal(adapter.snapshot().state, 'disposed');
  source.deny(false);
  ui(registry).writeLayout('plugin.second', empty);
  assert.equal(source.writes.length, 0);
  assert.equal(adapter.saveCurrent(), false);
  assert.equal(adapter.retryRead(), false);
  const cancelled = new AbortController();
  cancelled.abort();
  const other = fixture();
  const closed = createWorkspaceStorage({ registry, storage: other.storage, key: 'deviceforge.workspace.test', signal: cancelled.signal });
  assert.equal(closed.snapshot().state, 'disposed');
  assert.equal(other.reads(), 0);
  closed.dispose();
  registry.dispose();
});
