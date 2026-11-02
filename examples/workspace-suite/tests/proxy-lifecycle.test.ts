import test from 'node:test';
import assert from 'node:assert/strict';
import type { Dispose, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { mountFileDelegate } from '../browser/proxy-view.ts';
import { hostFixture } from './host-fixture.ts';

function fixture() {
  const f = hostFixture(), lifetime = new AbortController(), visibility = new Set<(visible: boolean) => void>();
  f.setCatalog({ workspaces: [], pages: [], views: [{
    id: 'public_files.browser', pluginId: 'public_files', generation: 1, title: '文件',
    provides: ['files.browser'],
  }] });
  const original = f.ui.open({
    instanceId: `${f.prefix}.caller`, workspaceId: 'chosen.workspace',
    provider: { pluginId: f.prefix, viewId: `${f.prefix}.main` }, target: { chosen: 'explicit' },
  }, lifetime.signal);
  const view: WorkspaceViewContext = {
    signal: lifetime.signal, snapshot: () => original,
    subscribeVisibility(listener) { visibility.add(listener); return () => { visibility.delete(listener); }; },
  };
  return { ...f, lifetime, view, visibility, original };
}

test('公开文件视图委托拥有独立实例，隐藏同步，关闭只回收自己的委托且幂等', async () => {
  const f = fixture();
  let released = 0, delegateId = '';
  const dispose = await mountFileDelegate(f.context, f.view, f.prefix, async (id, signal) => {
    delegateId = id;
    assert.equal(signal.aborted, false);
    return () => { released++; };
  });
  assert.notEqual(delegateId, f.original.instanceId);
  assert.deepEqual(f.instances.get(delegateId)?.target, f.original.target);
  for (const update of [...f.visibility]) update(false);
  assert.equal(f.instances.get(delegateId)?.visible, false);
  await dispose(); await dispose();
  assert.equal(released, 1);
  assert.deepEqual(f.closed, [delegateId]);
  assert.ok(f.instances.has(f.original.instanceId));
  assert.equal(f.visibility.size, 0);
  assert.equal(f.layouts.size, 0);
});

test('挂载晚到期间撤销先关闭自有委托，晚返回只释放旧挂载，不创建新实例或修改布局', async () => {
  const f = fixture();
  let complete: (release: Dispose) => void = () => {}, released = 0;
  const late = new Promise<Dispose>((resolve) => { complete = resolve; });
  const pending = mountFileDelegate(f.context, f.view, f.prefix, async () => late);
  const rejected = assert.rejects(pending, (error) => error instanceof DOMException && error.name === 'AbortError');
  f.lifetime.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.closed.length, 1);
  complete(() => { released++; });
  await rejected;
  assert.equal(released, 1);
  assert.equal(f.opened.length, 2);
  assert.ok(f.instances.has(f.original.instanceId));
  assert.equal(f.visibility.size, 0);
  assert.equal(f.layouts.size, 0);
});
