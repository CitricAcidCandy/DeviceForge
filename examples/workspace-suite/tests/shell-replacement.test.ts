import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Dispose, HostContext, JsonValue, LocalPointContribution, PointRef, UiAccess, WorkspaceViewDefinition,
} from '@deviceforge/plugin-sdk';
import createWorkspaceSuite from '../browser/index.ts';
import { createShellReplacement } from '../browser/shell-replacement.ts';
import { hostFixture } from './host-fixture.ts';

const POINT = { id: 'host.shell', version: '1' };
const ORIGINAL = { id: 'public.shell.choice', pluginId: 'public.shell', generation: 7 };
const START: JsonValue = { expected: ORIGINAL, behavior: 'delegate' };
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}
/** 只模拟公开贡献、选择和释放；真实视图挂载不使用伪造 HTMLElement。 */
function shellFixture() {
  const base = hostFixture(), extensions = base.context.extensions, oldPoints = extensions?.points;
  assert.ok(extensions && oldPoints);
  const originalView = { id: 'public.shell.main', pluginId: ORIGINAL.pluginId, generation: ORIGINAL.generation,
    title: '原外壳', provides: ['host.shell'] };
  base.setCatalog({ workspaces: [], pages: [], views: [originalView] });
  const original: LocalPointContribution = {
    id: ORIGINAL.id, point: POINT, mode: 'replace', order: 0,
    data: { pluginId: originalView.pluginId, viewId: originalView.id },
    provider: { pluginId: ORIGINAL.pluginId, generation: ORIGINAL.generation },
    state: 'active', reason: null, selected: true,
  };
  const candidates = new Map([[original.id, original]]), selections: (string | null)[] = [];
  const pointRegistrations: { id: string; active: boolean; releases: number }[] = [];
  const viewRegistrations: { definitions: readonly WorkspaceViewDefinition[]; active: boolean; releases: number }[] = [];
  let selectedId: string | null = ORIGINAL.id, nextPointRelease: Dispose = () => {}, nextViewRelease: Dispose = () => {};
  let beforeContribute: (() => void) | null = null;
  const checkPoint = (point: PointRef) => {
    assert.equal(point.id, POINT.id); assert.equal(point.version, POINT.version);
  };
  const ui: UiAccess = {
    ...base.ui,
    register(value) {
      const upstream = base.ui.register(value), release = nextViewRelease;
      nextViewRelease = () => {};
      const registration = { definitions: value.views ?? [], active: true, releases: 0 };
      viewRegistrations.push(registration);
      return async () => {
        registration.active = false; registration.releases++;
        const ids = new Set(registration.definitions.map((definition) => definition.id));
        const catalog = base.ui.catalog();
        base.setCatalog({ ...catalog, views: catalog.views.filter((view) => !ids.has(view.id)) });
        await upstream(); await release();
      };
    },
  };
  const context: HostContext = { ...base.context, ui, extensions: { ...extensions, points: {
    ...oldPoints,
    list(point) { checkPoint(point); return [...candidates.values()].map((value) => ({ ...value, selected: value.id === selectedId })); },
    selected(point) {
      checkPoint(point);
      const value = selectedId === null ? undefined : candidates.get(selectedId);
      return value ? { ...value, selected: true } : null;
    },
    select(point, id) {
      checkPoint(point);
      base.signal.signal.throwIfAborted();
      if (id !== null && !candidates.has(id)) throw new Error('测试选择目标不存在');
      selectedId = id; selections.push(id);
    },
    contribute(value) {
      checkPoint(value.point);
      const release = nextPointRelease;
      nextPointRelease = () => {};
      const registration = { id: value.id, active: true, releases: 0 };
      pointRegistrations.push(registration);
      const local: LocalPointContribution = { ...value, order: value.order ?? 0, mode: value.mode ?? 'append',
        provider: { pluginId: base.prefix, generation: 1 }, state: 'active', reason: null, selected: false };
      candidates.set(local.id, local);
      beforeContribute?.();
      return {
        dispose() { registration.active = false; registration.releases++; candidates.delete(local.id); return release(); },
        update() { throw new Error('本测试不更新贡献'); },
      };
    },
  } } };
  return {
    ...base, context, original, originalView, candidates, selections, pointRegistrations, viewRegistrations,
    get selectedId() { return selectedId; },
    changeSelection(id: string | null) { selectedId = id; },
    beforeContribute(action: () => void) { beforeContribute = action; },
    nextPointRelease(release: Dispose) { nextPointRelease = release; },
    nextViewRelease(release: Dispose) { nextViewRelease = release; },
  };
}

test('激活登记外壳替换开始、状态和恢复命令，保留已有路由及实例替换契约', async () => {
  const f = hostFixture();
  const plugin = createWorkspaceSuite({ id: f.prefix, version: '1', apiVersion: 2 });
  assert.ok(plugin.activate);
  try {
    await plugin.activate(f.context);
    const commands = new Set(f.contributions.flatMap((entry) => entry.commands ?? []).map((entry) => entry.id));
    for (const command of ['shell-replacement.start', 'shell-replacement.status', 'shell-replacement.restore'])
      assert.ok(commands.has(`${f.prefix}.${command}`), `缺少公开命令：${command}`);
    for (const command of ['replace-view', 'restore-view',
      'route-replacement.start', 'route-replacement.status', 'route-replacement.restore'])
      assert.ok(commands.has(`${f.prefix}.${command}`), `既有公开命令被移除：${command}`);
    assert.equal(f.counts.businessCalls, 0);
    assert.equal(f.counts.mounted, 0);
  } finally { await f.dispose(); }
});

test('显式开始才选择自有候选，登记只报告未观测挂载且不派发业务或打开子实例', async () => {
  const f = shellFixture(), replacement = createShellReplacement(f.context, f.prefix);
  try {
    assert.equal(f.selections.length, 0);
    assert.equal(f.pointRegistrations.length, 0);
    const started = replacement.start(START);
    assert.ok(started.replacementId.startsWith(`${f.prefix}.`));
    assert.ok(started.contributionId.startsWith(`${started.replacementId}.`));
    assert.equal(started.original.id, ORIGINAL.id);
    assert.equal(started.original.pluginId, ORIGINAL.pluginId);
    assert.equal(started.original.generation, ORIGINAL.generation);
    assert.equal(started.behavior, 'delegate');
    assert.equal(started.registration, 'active');
    assert.equal(started.mount, 'not_observed');
    assert.equal(started.mountCount, 0);
    assert.equal(started.releaseCount, 0);
    assert.equal(started.error, null);
    assert.equal(started.selected, true);
    assert.equal(f.selectedId, started.contributionId);
    assert.equal(f.selections.length, 1);
    assert.equal(f.candidates.get(started.contributionId)?.mode, 'replace');
    assert.equal(f.viewRegistrations.length, 1);
    assert.ok(f.viewRegistrations[0]?.definitions[0]?.provides?.includes('host.shell'));
    assert.equal(f.opened.length, 0);
    assert.equal(f.counts.businessCalls, 0);
    assert.equal(f.counts.mounted, 0);
    const observed = replacement.status({ replacementId: started.replacementId });
    assert.equal(observed.mount, 'not_observed');
    assert.equal(observed.selected, true);
    await replacement.restore({ replacementId: started.replacementId }, new AbortController().signal);
    const fail = replacement.start({ expected: ORIGINAL, behavior: 'fail' });
    assert.equal(fail.behavior, 'fail');
    assert.equal(fail.mount, 'not_observed');
    assert.equal(fail.mountCount, 0);
    assert.equal(fail.registration, 'active');
  } finally { await f.dispose(); }
});

test('严格输入和原提供者代次必须匹配，视图缺失歧义或非外壳能力不登记', async () => {
  const f = shellFixture(), replacement = createShellReplacement(f.context, f.prefix);
  try {
    const invalid: JsonValue[] = [null, [], {}, { expected: ORIGINAL },
      { expected: ORIGINAL, behavior: 'delegate', extra: true },
      { expected: { ...ORIGINAL, generation: 0 }, behavior: 'delegate' },
      { expected: { ...ORIGINAL, generation: 1.5 }, behavior: 'delegate' },
      { expected: { ...ORIGINAL, id: '' }, behavior: 'delegate' },
      { expected: { ...ORIGINAL, extra: true }, behavior: 'delegate' },
      { expected: ORIGINAL, behavior: 'unknown' }];
    for (const input of invalid) assert.throws(() => replacement.start(input));
    for (const expected of [{ ...ORIGINAL, generation: ORIGINAL.generation + 1 },
      { ...ORIGINAL, id: 'foreign.choice' }, { ...ORIGINAL, pluginId: 'foreign.plugin' }])
      assert.throws(() => replacement.start({ expected, behavior: 'delegate' }));
    for (const views of [[], [f.originalView, f.originalView], [{ ...f.originalView, provides: ['other.view'] }]]) {
      f.setCatalog({ workspaces: [], pages: [], views });
      assert.throws(() => replacement.start(START));
    }
    f.setCatalog({ workspaces: [], pages: [], views: [f.originalView] });
    assert.equal(f.pointRegistrations.length, 0);
    assert.equal(f.viewRegistrations.length, 0);
    assert.equal(f.selections.length, 0);
    const started = replacement.start(START);
    assert.throws(() => replacement.start(START));
    for (const input of [null, {}, { replacementId: started.replacementId, extra: true }]) {
      assert.throws(() => replacement.status(input));
      await assert.rejects(replacement.restore(input, new AbortController().signal));
    }
    assert.equal(f.pointRegistrations.length, 1);
  } finally { await f.dispose(); }
});

test('明确恢复先选回相同原代再只撤自有资格，旧票据不影响新候选或他人贡献', async () => {
  const f = shellFixture(), replacement = createShellReplacement(f.context, f.prefix);
  try {
    const first = replacement.start(START);
    const restored = await replacement.restore({ replacementId: first.replacementId }, new AbortController().signal);
    assert.equal(f.selectedId, ORIGINAL.id);
    assert.equal(restored.registration, 'withdrawn');
    assert.equal(restored.mount, 'not_observed');
    assert.equal(restored.selected, false);
    assert.equal(f.candidates.has(ORIGINAL.id), true);
    assert.equal(f.candidates.has(first.contributionId), false);
    assert.equal(f.pointRegistrations[0]?.releases, 1);
    assert.equal(f.viewRegistrations[0]?.releases, 1);
    const next = replacement.start(START);
    assert.notEqual(first.replacementId, next.replacementId);
    await assert.rejects(replacement.restore({ replacementId: first.replacementId }, new AbortController().signal));
    assert.equal(f.selectedId, next.contributionId);
    assert.equal(f.pointRegistrations[1]?.releases, 0);
    assert.equal(f.viewRegistrations[1]?.releases, 0);
    const newGeneration = createShellReplacement(f.context, f.prefix);
    assert.throws(() => newGeneration.status({ replacementId: next.replacementId }));
    await assert.rejects(newGeneration.restore({ replacementId: next.replacementId }, new AbortController().signal));
    assert.equal(replacement.status({ replacementId: next.replacementId }).registration, 'active');
  } finally { await f.dispose(); }
});

test('其他选择和原提供者换代时恢复必须冲突，不能覆盖后来选择或撤销现有候选', async () => {
  const f = shellFixture(), replacement = createShellReplacement(f.context, f.prefix);
  try {
    const started = replacement.start(START), calls = f.selections.length;
    f.changeSelection(ORIGINAL.id);
    const status = replacement.status({ replacementId: started.replacementId });
    assert.equal(status.selected, false);
    assert.equal(status.registration, 'active');
    await assert.rejects(replacement.restore({ replacementId: started.replacementId }, new AbortController().signal));
    assert.equal(f.selections.length, calls);
    assert.equal(f.selectedId, ORIGINAL.id);
    f.changeSelection(started.contributionId);
    f.candidates.set(ORIGINAL.id, { ...f.original, provider: { pluginId: ORIGINAL.pluginId, generation: ORIGINAL.generation + 1 } });
    await assert.rejects(replacement.restore({ replacementId: started.replacementId }, new AbortController().signal));
    assert.equal(f.selectedId, started.contributionId);
    assert.equal(f.selections.length, calls);
    assert.equal(f.pointRegistrations[0]?.releases, 0);
    assert.equal(f.viewRegistrations[0]?.releases, 0);
    f.candidates.delete(ORIGINAL.id);
    await assert.rejects(replacement.restore({ replacementId: started.replacementId }, new AbortController().signal));
    assert.equal(f.pointRegistrations[0]?.active, true);
  } finally { await f.dispose(); }
});

test('准备期间选择变化只回收本次登记，销毁不使用已撤销作用域擅自选回原外壳', async () => {
  const f = shellFixture(), replacement = createShellReplacement(f.context, f.prefix);
  try {
    f.beforeContribute(() => { f.changeSelection(null); });
    assert.throws(() => replacement.start(START));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.selectedId, null);
    assert.equal(f.selections.length, 0);
    assert.equal(f.pointRegistrations[0]?.active, false);
    assert.equal(f.viewRegistrations[0]?.active, false);
    assert.equal(f.pointRegistrations[0]?.releases, 1);
    assert.equal(f.viewRegistrations[0]?.releases, 1);
    assert.equal(f.candidates.has(ORIGINAL.id), true);
    f.beforeContribute(() => {});
    f.changeSelection(ORIGINAL.id);
    const current = replacement.start(START);
    const selectedCount = f.selections.length;
    await f.dispose();
    assert.equal(f.selections.length, selectedCount);
    assert.equal(f.candidates.has(current.contributionId), false);
    assert.equal(f.candidates.has(ORIGINAL.id), true);
    assert.ok(f.pointRegistrations.every((entry) => entry.releases === 1));
    assert.ok(f.viewRegistrations.every((entry) => entry.releases === 1));
    assert.throws(() => replacement.start(START));
    assert.throws(() => replacement.status({ replacementId: current.replacementId }));
  } finally { if (!f.signal.signal.aborted) await f.dispose(); }
});

test('撤回取消不重放释放且晚到结果不影响独立新候选，真实回收失败保持可查', async () => {
  const f = shellFixture(), replacement = createShellReplacement(f.context, f.prefix), pending = deferred();
  f.nextPointRelease(() => pending.promise);
  try {
    const first = replacement.start(START), caller = new AbortController();
    const request = replacement.restore({ replacementId: first.replacementId }, caller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.selectedId, ORIGINAL.id);
    assert.equal(f.pointRegistrations[0]?.releases, 1);
    assert.equal(f.viewRegistrations[0]?.releases, 1);
    caller.abort();
    await assert.rejects(request);
    const observed = replacement.status({ replacementId: first.replacementId });
    assert.ok(observed.registration === 'unknown' || observed.registration === 'withdrawing');
    await assert.rejects(replacement.restore({ replacementId: first.replacementId }, new AbortController().signal));
    const next = replacement.start(START);
    pending.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.pointRegistrations[0]?.releases, 1);
    assert.equal(f.viewRegistrations[0]?.releases, 1);
    assert.equal(f.selectedId, next.contributionId);
    assert.equal(replacement.status({ replacementId: next.replacementId }).registration, 'active');
    await replacement.restore({ replacementId: next.replacementId }, new AbortController().signal);
    const failure = new Error('本次视图回收真实失败');
    f.nextViewRelease(() => { throw failure; });
    const failed = replacement.start(START);
    await assert.rejects(replacement.restore({ replacementId: failed.replacementId }, new AbortController().signal),
      (error) => error instanceof AggregateError && error.errors.includes(failure));
    const unknown = replacement.status({ replacementId: failed.replacementId });
    assert.equal(unknown.registration, 'unknown');
    assert.ok(unknown.error);
    assert.equal(f.selectedId, ORIGINAL.id);
    const independent = replacement.start(START);
    assert.equal(independent.registration, 'active');
    assert.equal(replacement.status({ replacementId: failed.replacementId }).registration, 'unknown');
  } finally {
    pending.resolve();
    await assert.rejects(f.dispose(), (error) => error instanceof AggregateError);
  }
});

test('每代最多保留十六项外壳票据，淘汰历史不重复回收或影响原提供者', async () => {
  const f = shellFixture(), replacement = createShellReplacement(f.context, f.prefix), receipts: string[] = [];
  try {
    for (let index = 0; index < 18; index++) {
      const started = replacement.start(START);
      receipts.push(started.replacementId);
      await replacement.restore({ replacementId: started.replacementId }, new AbortController().signal);
    }
    assert.equal(new Set(receipts).size, 18);
    const first = receipts[0], second = receipts[1];
    assert.ok(first && second);
    assert.throws(() => replacement.status({ replacementId: first }));
    assert.throws(() => replacement.status({ replacementId: second }));
    for (const replacementId of receipts.slice(2))
      assert.equal(replacement.status({ replacementId }).registration, 'withdrawn');
    assert.equal(f.selectedId, ORIGINAL.id);
    assert.equal(f.candidates.has(ORIGINAL.id), true);
    assert.ok(f.pointRegistrations.every((entry) => !entry.active && entry.releases === 1));
    assert.ok(f.viewRegistrations.every((entry) => !entry.active && entry.releases === 1));
  } finally { await f.dispose(); }
});
