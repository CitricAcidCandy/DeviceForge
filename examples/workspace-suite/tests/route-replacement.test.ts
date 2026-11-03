import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ComponentContribution, ComponentInfo, Dispose, HostContext, JsonValue, WorkspaceCatalog,
} from '@deviceforge/plugin-sdk';
import createWorkspaceSuite from '../browser/index.ts';
import { createRouteReplacement } from '../browser/route-replacement.ts';
import { hostFixture } from './host-fixture.ts';

const START: JsonValue = { slot: 'route.files', expectedReplacement: null, behavior: 'files' };

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

/** 只模拟公开目录、资格撤销和释放回执；挂载由真实 DOM 专项验证。 */
function routeFixture() {
  const base = hostFixture(), extensions = base.context.extensions;
  assert.ok(extensions);
  const foreign: ComponentInfo = {
    id: 'other.append', pluginId: 'other.browser', generation: 1,
    title: '其他插件内容', slot: 'route.files', mode: 'append',
  };
  const external = new Map([[foreign.id, foreign]]);
  const registrations: { contribution: ComponentContribution; active: boolean; releases: number }[] = [];
  let nextRelease: Dispose = () => {};
  const catalog: WorkspaceCatalog = {
    workspaces: [{ id: 'public.files.workspace', pluginId: 'public.files', generation: 1, title: '文件工作区' }],
    pages: [{ id: 'public.files.page', pluginId: 'public.files', generation: 1, title: '文件',
      route: '/files', workspaceId: 'public.files.workspace', viewId: null }],
    views: [{ id: 'public.files.main', pluginId: 'public.files', generation: 1, title: '文件', provides: ['files.browser'] }],
  };
  base.setCatalog(catalog);
  const context: HostContext = {
    ...base.context,
    extensions: {
      ...extensions,
      catalog: () => ({
        components: [...external.values(), ...registrations.filter((entry) => entry.active).map((entry) => ({
          id: entry.contribution.id, title: entry.contribution.title, pluginId: base.prefix, generation: 1,
          slot: entry.contribution.slot, mode: entry.contribution.mode ?? 'append',
        }))], modules: [], commands: [], services: [],
      }),
      register(value) {
        const selectedRelease = nextRelease;
        nextRelease = () => {};
        const owned = (value.components ?? []).map((contribution) => ({ contribution, active: true, releases: 0 }));
        registrations.push(...owned);
        return () => {
          for (const entry of owned) { entry.active = false; entry.releases++; }
          return selectedRelease();
        };
      },
    },
  };
  return {
    ...base, context, catalog, registrations, external,
    nextRelease(value: Dispose) { nextRelease = value; },
  };
}

test('激活登记路由替换的开始、状态和恢复命令，并保留既有实例替换契约', async () => {
  const f = hostFixture();
  const plugin = createWorkspaceSuite({ id: f.prefix, version: '1', apiVersion: 2 });
  assert.ok(plugin.activate);
  try {
    await plugin.activate(f.context);
    const ids = f.contributions.flatMap((entry) => entry.commands ?? []).map((entry) => entry.id);
    for (const command of ['route-replacement.start', 'route-replacement.status', 'route-replacement.restore'])
      assert.ok(ids.includes(`${f.prefix}.${command}`), `缺少公开命令：${command}`);
    assert.ok(ids.includes(`${f.prefix}.replace-view`));
    assert.ok(ids.includes(`${f.prefix}.restore-view`));
    assert.deepEqual(f.counts, { businessCalls: 0, mounted: 0 });
  } finally { await f.dispose(); }
});

test('登记只证明资格待挂载，严格输入、目录歧义和槽位冲突均不得新增贡献', async () => {
  const f = routeFixture(), replacement = createRouteReplacement(f.context, f.prefix);
  try {
    const invalid: JsonValue[] = [null, {}, [],
      { slot: 'route.devices', expectedReplacement: null, behavior: 'files' },
      { slot: 'route.files', expectedReplacement: 'old', behavior: 'files' },
      { slot: 'route.files', expectedReplacement: null, behavior: 'unknown' },
      { slot: 'route.files', expectedReplacement: null, behavior: 'files', extra: true }];
    for (const input of invalid) assert.throws(() => replacement.start(input));
    f.setCatalog({ ...f.catalog, pages: [] });
    assert.throws(() => replacement.start(START));
    f.setCatalog({ ...f.catalog, pages: [...f.catalog.pages, ...f.catalog.pages] });
    assert.throws(() => replacement.start(START));
    f.setCatalog({ ...f.catalog, pages: f.catalog.pages.map((page) => ({ ...page, workspaceId: null })) });
    assert.throws(() => replacement.start(START));
    f.setCatalog(f.catalog);
    const foreign: ComponentInfo = { id: 'other.replace', title: '其他替换', pluginId: 'other.browser',
      generation: 2, slot: 'route.files', mode: 'replace' };
    f.external.set(foreign.id, foreign);
    assert.throws(() => replacement.start(START));
    assert.equal(f.registrations.length, 0);
    f.external.delete(foreign.id);
    const pending = replacement.start(START), registered = f.registrations[0];
    assert.ok(registered);
    assert.ok(pending.replacementId.startsWith(`${f.prefix}.`));
    assert.deepEqual(pending, {
      replacementId: pending.replacementId, slot: 'route.files', behavior: 'files', registration: 'active',
      mount: 'not_observed', mountCount: 0, releaseCount: 0, error: null,
    });
    assert.equal(registered.contribution.id, pending.replacementId);
    assert.equal(registered.contribution.mode, 'replace');
    assert.equal(registered.contribution.slot, 'route.files');
    assert.throws(() => replacement.start(START));
    for (const input of [null, {}, { replacementId: pending.replacementId, extra: true }]) {
      assert.throws(() => replacement.status(input));
      await assert.rejects(replacement.restore(input, new AbortController().signal));
    }
    assert.equal(f.registrations.length, 1);
    assert.deepEqual(f.counts, { businessCalls: 0, mounted: 0 });
  } finally { await f.dispose(); }
});

test('恢复只撤本代自有票据，保留他人贡献及新替换，旧票据不能再次释放', async () => {
  const f = routeFixture(), replacement = createRouteReplacement(f.context, f.prefix);
  try {
    const first = replacement.start(START);
    const restored = await replacement.restore({ replacementId: first.replacementId }, new AbortController().signal);
    assert.equal(restored.registration, 'withdrawn');
    assert.equal(restored.mount, 'not_observed');
    assert.equal(f.registrations[0]?.active, false);
    assert.equal(f.registrations[0]?.releases, 1);
    assert.ok(f.external.has('other.append'));
    const second = replacement.start(START);
    assert.notEqual(second.replacementId, first.replacementId);
    await assert.rejects(replacement.restore({ replacementId: first.replacementId }, new AbortController().signal));
    assert.equal(f.registrations[0]?.releases, 1);
    assert.equal(f.registrations[1]?.active, true);
    assert.equal(f.registrations[1]?.releases, 0);
    const nextGeneration = createRouteReplacement(f.context, f.prefix);
    assert.throws(() => nextGeneration.status({ replacementId: first.replacementId }));
    await assert.rejects(nextGeneration.restore({ replacementId: second.replacementId }, new AbortController().signal));
    assert.equal(replacement.status({ replacementId: second.replacementId }).registration, 'active');
  } finally { await f.dispose(); }
});

test('取消撤回等待保留未知诊断且不重放释放，晚到回执不能撤销独立新替换', async () => {
  const f = routeFixture(), replacement = createRouteReplacement(f.context, f.prefix);
  const pending = deferred(), caller = new AbortController();
  f.nextRelease(() => pending.promise);
  try {
    const first = replacement.start(START);
    const request = replacement.restore({ replacementId: first.replacementId }, caller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.registrations[0]?.active, false);
    assert.equal(f.registrations[0]?.releases, 1);
    assert.equal(replacement.status({ replacementId: first.replacementId }).registration, 'withdrawing');
    caller.abort();
    await assert.rejects(request);
    const unknown = replacement.status({ replacementId: first.replacementId });
    assert.equal(unknown.registration, 'unknown');
    assert.ok(unknown.error);
    await assert.rejects(replacement.restore({ replacementId: first.replacementId }, new AbortController().signal));
    assert.equal(f.registrations[0]?.releases, 1);
    const next = replacement.start(START);
    assert.equal(next.registration, 'active');
    pending.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.registrations[0]?.releases, 1);
    assert.equal(f.registrations[1]?.active, true);
    assert.equal(replacement.status({ replacementId: next.replacementId }).registration, 'active');
    assert.ok(f.external.has('other.append'));
  } finally { pending.resolve(); await f.dispose(); }
});

test('销毁只清理自有资格并收齐原释放，旧代不可继续操作且新代不受旧票据影响', async () => {
  const f = routeFixture(), replacement = createRouteReplacement(f.context, f.prefix), pending = deferred();
  f.nextRelease(() => pending.promise);
  const first = replacement.start(START);
  const disposing = f.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.registrations[0]?.active, false);
  assert.equal(f.registrations[0]?.releases, 1);
  assert.ok(f.external.has('other.append'));
  assert.throws(() => replacement.start(START));
  assert.throws(() => replacement.status({ replacementId: first.replacementId }));
  pending.resolve();
  await disposing;
  assert.equal(f.registrations[0]?.releases, 1);
  const next = routeFixture(), nextGeneration = createRouteReplacement(next.context, next.prefix);
  try {
    await assert.rejects(nextGeneration.restore({ replacementId: first.replacementId }, new AbortController().signal));
    const current = nextGeneration.start(START);
    assert.notEqual(current.replacementId, first.replacementId);
    assert.equal(current.registration, 'active');
    assert.equal(next.registrations[0]?.releases, 0);
  } finally { await next.dispose(); }
});

test('已撤回历史最多保留十六项，淘汰旧票据不影响现有替换或重复派发释放', async () => {
  const f = routeFixture(), replacement = createRouteReplacement(f.context, f.prefix), receipts: string[] = [];
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
    assert.ok(f.registrations.every((entry) => !entry.active && entry.releases === 1));
    assert.ok(f.external.has('other.append'));
  } finally { await f.dispose(); }
});
