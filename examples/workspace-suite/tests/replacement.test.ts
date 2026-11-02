import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostContext, JsonValue, UiAccess, WorkspaceInstance, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import createWorkspaceSuite from '../browser/index.ts';
import { createViewReplacement } from '../browser/replacement.ts';
import type { SelectionObservation, ViewReplacementResult } from '../browser/replacement.ts';
import { hostFixture } from './host-fixture.ts';

function fixture() {
  const host = hostFixture(), calls: { instanceId: string; provider: WorkspaceViewRef | null }[] = [];
  const workspaceId = 'explicit.workspace', instanceId = `${host.prefix}.explicit`;
  host.setCatalog({
    pages: [],
    workspaces: [{ id: workspaceId, pluginId: host.prefix, generation: 1, title: '明确工作区' }],
    views: [
      { id: 'original.view', pluginId: 'original', generation: 3, title: '原视图', provides: [] },
      { id: 'replacement.view', pluginId: 'replacement', generation: 7, title: '替换视图', provides: [] },
      { id: 'other.view', pluginId: 'other', generation: 9, title: '另一视图', provides: [] },
    ],
  });
  const initial: WorkspaceInstance = {
    instanceId, workspaceId, pluginId: host.prefix, generation: 11,
    provider: { pluginId: 'original', viewId: 'original.view' }, providerGeneration: 3,
    target: { kind: 'file', id: 'explicit-target' }, visible: true, state: 'ready', reason: null,
  };
  host.instances.set(instanceId, structuredClone(initial));
  let selectionFailure: Error | null = null;
  const ui: UiAccess = {
    ...host.ui,
    selectProvider(id, provider) {
      calls.push({ instanceId: id, provider: structuredClone(provider) });
      if (selectionFailure) throw selectionFailure;
      const current = host.instances.get(id);
      if (!current) throw new Error('明确实例不存在');
      const definition = host.ui.catalog().views.find((view) =>
        view.pluginId === provider?.pluginId && view.id === provider.viewId);
      const selected: WorkspaceInstance = {
        ...current, provider, generation: current.generation + 1,
        providerGeneration: definition?.generation ?? null,
        state: provider ? 'ready' : 'unselected', reason: provider ? null : 'provider_unselected',
      };
      host.instances.set(id, selected);
      return selected;
    },
  };
  const context: HostContext = { ...host.context, ui };
  const controller = createViewReplacement(context, host.prefix);
  const observation = (instance: WorkspaceInstance): SelectionObservation => ({
    ownerPluginId: instance.pluginId, generation: instance.generation, provider: instance.provider,
    providerGeneration: instance.providerGeneration, target: structuredClone(instance.target),
  });
  const replaceInput = () => ({
    instanceId, workspaceId, expected: observation(initial),
    provider: { pluginId: 'replacement', viewId: 'replacement.view', generation: 7 },
  });
  const restoreInput = (result: ViewReplacementResult) => ({
    replacementId: result.replacementId, instanceId, workspaceId, expected: result.current,
  });
  return {
    ...host, context, ui, controller, calls, initial, instanceId, workspaceId, observation, replaceInput, restoreInput,
    failSelection(error: Error) { selectionFailure = error; },
  };
}

test('显式实例替换与恢复保留目标，仅确认选择不伪造挂载完成', async () => {
  const f = fixture();
  const replaced = f.controller.replace(f.replaceInput(), f.context.signal);
  assert.equal(replaced.status, 'selected');
  assert.equal(replaced.mount, 'not_observed');
  assert.deepEqual(replaced.original, f.observation(f.initial));
  assert.equal(replaced.current.generation, 12);
  assert.deepEqual(replaced.current.provider, { pluginId: 'replacement', viewId: 'replacement.view' });
  assert.deepEqual(replaced.current.target, f.initial.target);
  const restored = f.controller.restore(f.restoreInput(replaced), f.context.signal);
  assert.equal(restored.status, 'restored'); assert.equal(restored.mount, 'not_observed');
  assert.deepEqual(restored.current.provider, f.initial.provider);
  assert.equal(restored.current.generation, 13);
  assert.equal(f.calls.length, 2);
  assert.throws(() => f.controller.restore(f.restoreInput(replaced), f.context.signal), /恢复记录/u);
  await f.dispose();
});

test('缺少明确身份、原选择、目标或代次时不选择任何实例', async () => {
  const f = fixture(), input = f.replaceInput();
  const cases: JsonValue[] = [
    {}, { ...input, instanceId: 'missing.instance' }, { ...input, workspaceId: 'other.workspace' },
    { ...input, expected: { ...input.expected, ownerPluginId: 'someone-else' } },
    { ...input, expected: { ...input.expected, generation: 10 } },
    { ...input, expected: { ...input.expected, providerGeneration: 2 } },
    { ...input, expected: { ...input.expected, target: { kind: 'file', id: 'another-target' } } },
    { ...input, provider: { ...input.provider, generation: 6 } },
    { ...input, provider: { ...input.provider, viewId: 'absent.view' } },
  ];
  for (const value of cases) assert.throws(() => f.controller.replace(value, f.context.signal));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.instances.get(f.instanceId), f.initial);
  await f.dispose();
});

test('选择抛错保留可见原选择，不自动重试或执行恢复', async () => {
  const f = fixture(); f.failSelection(new Error('宿主拒绝本次选择'));
  assert.throws(() => f.controller.replace(f.replaceInput(), f.context.signal), /宿主拒绝/u);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.instances.get(f.instanceId), f.initial);
  await f.dispose();
});

test('恢复拒绝覆盖另一选择、目标换代或原提供者换代', async () => {
  for (const change of ['provider', 'target', 'original-generation']) {
    const f = fixture(), replaced = f.controller.replace(f.replaceInput(), f.context.signal);
    const selected = f.instances.get(f.instanceId);
    assert.ok(selected);
    if (change === 'provider') f.ui.selectProvider(f.instanceId, { pluginId: 'other', viewId: 'other.view' });
    if (change === 'target') f.instances.set(f.instanceId, {
      ...selected, generation: selected.generation + 1, target: { kind: 'file', id: 'new-target' },
    });
    if (change === 'original-generation') f.setCatalog({
      ...f.ui.catalog(), views: f.ui.catalog().views.map((view) =>
        view.pluginId === 'original' ? { ...view, generation: 4 } : view),
    });
    const before = f.calls.length;
    assert.throws(() => f.controller.restore(f.restoreInput(replaced), f.context.signal));
    assert.equal(f.calls.length, before);
    await f.dispose();
  }
});

test('调用取消或插件撤销后旧恢复记录失效，不自动恢复任何选择', async () => {
  const f = fixture(), cancelled = new AbortController();
  cancelled.abort(new Error('取消本次命令'));
  assert.throws(() => f.controller.replace(f.replaceInput(), cancelled.signal), /取消本次/u);
  const replaced = f.controller.replace(f.replaceInput(), f.context.signal);
  await f.dispose();
  assert.throws(() => f.controller.restore(f.restoreInput(replaced), new AbortController().signal));
  assert.equal(f.calls.length, 1);
});

test('新替换使旧恢复记录失效，原未选择状态可显式恢复为null', async () => {
  const f = fixture(), first = f.controller.replace(f.replaceInput(), f.context.signal);
  const second = f.controller.replace({
    ...f.replaceInput(), expected: first.current,
    provider: { pluginId: 'other', viewId: 'other.view', generation: 9 },
  }, f.context.signal);
  assert.throws(() => f.controller.restore(f.restoreInput(first), f.context.signal), /恢复记录/u);
  assert.equal(f.calls.length, 2);
  assert.equal(f.controller.restore(f.restoreInput(second), f.context.signal).current.provider?.pluginId, 'replacement');
  await f.dispose();
  const unselected = fixture();
  const original: WorkspaceInstance = {
    ...unselected.initial, provider: null, providerGeneration: null, state: 'unselected', reason: 'provider_unselected',
  };
  unselected.instances.set(unselected.instanceId, original);
  const selected = unselected.controller.replace({
    ...unselected.replaceInput(), expected: unselected.observation(original),
  }, unselected.context.signal);
  const restored = unselected.controller.restore(unselected.restoreInput(selected), unselected.context.signal);
  assert.equal(restored.current.provider, null);
  assert.equal(restored.current.providerGeneration, null);
  await unselected.dispose();
});

test('宿主选择后出现另一回执时不自动覆盖或宣称挂载失败原子回滚', async () => {
  const f = fixture(), ui: UiAccess = {
    ...f.ui,
    selectProvider(id, reference) {
      const returned = f.ui.selectProvider(id, reference);
      f.ui.selectProvider(id, { pluginId: 'other', viewId: 'other.view' });
      return returned;
    },
  };
  const controller = createViewReplacement({ ...f.context, ui }, f.prefix);
  assert.throws(() => controller.replace(f.replaceInput(), f.context.signal), /回读未确认/u);
  assert.equal(f.calls.length, 2);
  assert.equal(f.instances.get(f.instanceId)?.provider?.pluginId, 'other');
  await f.dispose();
});

test('真实工厂登记公开替换与恢复命令，激活仍不调用选择或业务', async () => {
  const f = fixture(), plugin = createWorkspaceSuite({ id: f.prefix, version: '1.0.0', apiVersion: 2 });
  await plugin.activate?.(f.context);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.counts, { businessCalls: 0, mounted: 0 });
  const commands = f.contributions.flatMap((contribution) => contribution.commands ?? []);
  const replace = commands.find((command) => command.id === `${f.prefix}.replace-view`);
  const restore = commands.find((command) => command.id === `${f.prefix}.restore-view`);
  assert.ok(replace); assert.ok(restore);
  const result = await replace.execute(f.replaceInput(), f.context, f.context.signal);
  assert.equal(result.logId, null);
  assert.equal(f.calls.length, 1);
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data) ||
      typeof result.data.replacementId !== 'string' || result.data.current === undefined)
    throw new Error('替换回执必须含明确恢复标识与当前观测');
  const restored = await restore.execute({
    replacementId: result.data.replacementId, instanceId: f.instanceId, workspaceId: f.workspaceId,
    expected: result.data.current,
  }, f.context, f.context.signal);
  assert.equal(restored.logId, null);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.instances.get(f.instanceId)?.provider, f.initial.provider);
  await f.dispose();
});
