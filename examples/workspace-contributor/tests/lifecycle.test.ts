import test from 'node:test';
import assert from 'node:assert/strict';
import createContributor from '../browser/index.ts';
import type {
  CommandContribution, Dispose, HostContext, HostResult, JsonValue,
  LocalPointContribution, PluginContributions, PointContribution, ServiceRef,
} from '@deviceforge/plugin-sdk';

function fixture() {
  const lifetime = new AbortController(), rootCommands = new Map<string, CommandContribution>();
  const featureCommands = new Map<string, CommandContribution>(), contributions: PointContribution[] = [];
  let pointExists = false, setup: ((context: HostContext) => void | Dispose | Promise<void | Dispose>) | null = null;
  let feature: AbortController | null = null, release: Dispose | null = null, featureId = '', state = 'waiting';
  const calls: { ref: ServiceRef; input: JsonValue }[] = [];
  let read: () => Promise<HostResult<JsonValue>> = async () => ({ data: { value: { message: '真实消息' },
    revision: 'provider-generation:0' }, logId: 'read-log' });
  const registered = (value: PluginContributions, target: Map<string, CommandContribution>) => {
    for (const command of value.commands ?? []) target.set(command.id, command);
    return () => { for (const command of value.commands ?? []) target.delete(command.id); };
  };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal,
    async listOperations() { throw new Error('激活不得联网'); },
    async submit() { throw new Error('激活不得提交'); }, async getJob() { throw new Error('不得猜任务'); },
    async cancelJob() { throw new Error('不得取消后台'); }, subscribeOperations: () => () => {},
    onDispose: (dispose) => dispose,
    extensions: {
      register: (value) => registered(value, rootCommands),
      catalog: () => ({ components: [], commands: [], modules: [], services: [] }),
      async executeCommand() { throw new Error('不派发其他命令'); },
      async callService() { throw new Error('只使用公开版本化服务'); },
      subscribeEvent: () => () => {}, emitEvent() {}, getState: () => undefined,
      setState() {}, subscribeState: () => () => {},
      points: {
        define() { throw new Error('消费者不定义提供者点'); },
        contribute(value) {
          contributions.push(value);
          return { update() { throw new Error('本测试不更新'); }, dispose() {} };
        },
        catalog: () => ({ definitions: [], contributions: [] }),
        list: () => contributions.map((value): LocalPointContribution => ({
          ...value, order: value.order ?? 0, mode: value.mode ?? 'append',
          provider: { pluginId: 'workspace_contributor', generation: 1 },
          state: pointExists ? 'active' : 'waiting', reason: pointExists ? null : 'point_missing', selected: false,
        })),
        selected: () => null, select() { throw new Error('不能擅自选择替换'); }, subscribe: () => () => {},
      },
    },
    services: {
      catalog: () => [],
      async call(ref, input) { calls.push({ ref, input }); return read(); },
      async callTyped() { throw new Error('未使用类型服务'); },
      whenAvailable(id, required, callback) {
        featureId = id;
        assert.deepEqual(required.map((ref) => ref.id),
          ['workspace_suite.browser.message.read', 'workspace_suite.browser.normalize']);
        setup = callback;
        return () => {};
      },
      diagnostics: () => [{ featureId,
        state: state === 'active' ? 'active' : 'waiting', missing: [], error: null, cleanupErrors: [] }],
    },
  };
  return {
    context, rootCommands, featureCommands, calls,
    point(value: boolean) { pointExists = value; },
    setRead(next: typeof read) { read = next; },
    async available() {
      assert.ok(setup);
      const controller = new AbortController();
      feature = controller;
      const extensions = context.extensions;
      assert.ok(extensions);
      const child: HostContext = { ...context, signal: controller.signal,
        extensions: { ...extensions, register: (value) => registered(value, featureCommands) } };
      release = (await setup(child)) ?? null;
      state = 'active';
      return child;
    },
    async revoke() {
      feature?.abort(); featureCommands.clear();
      if (release) await release();
      release = null; state = 'waiting';
    },
  };
}

test('先于提供者贡献时等待，根状态命令持续可用；依赖恢复只登记功能命令', async () => {
  const f = fixture(), plugin = createContributor({ id: 'workspace_contributor', version: '1', apiVersion: 2 });
  assert.ok(plugin.activate);
  await plugin.activate(f.context);
  const status = f.rootCommands.get('workspace_contributor.status');
  assert.ok(status);
  const initial = await status.execute({}, f.context, new AbortController().signal);
  assert.match(JSON.stringify(initial.data), /waiting/);
  assert.equal(f.featureCommands.size, 0);
  f.point(true);
  const child = await f.available(), read = f.featureCommands.get('workspace_contributor.read-provider');
  assert.ok(read);
  assert.equal((await read.execute({}, child, new AbortController().signal)).logId, 'read-log');
  await f.revoke(); f.point(false);
  assert.equal(f.featureCommands.size, 0);
  assert.equal(f.rootCommands.size, 1);
  assert.match(JSON.stringify((await status.execute({}, f.context, new AbortController().signal)).data), /waiting/);
  assert.equal(f.calls.length, 1);
});

test('依赖撤销后晚结果不记为本代完成，恢复创建新的功能上下文，独立命令不丢失', async () => {
  const f = fixture(), plugin = createContributor({ id: 'workspace_contributor', version: '1', apiVersion: 2 });
  assert.ok(plugin.activate);
  await plugin.activate(f.context);
  let resolve: (value: HostResult<JsonValue>) => void = () => {};
  const pending = new Promise<HostResult<JsonValue>>((accept) => { resolve = accept; });
  f.setRead(() => pending);
  const child = await f.available(), read = f.featureCommands.get('workspace_contributor.read-provider');
  assert.ok(read);
  const result = read.execute({}, child, new AbortController().signal);
  await f.revoke();
  resolve({ data: { value: { message: '旧结果' }, revision: 'old' }, logId: 'old-log' });
  await assert.rejects(result);
  f.setRead(async () => ({ data: { value: { message: '新结果' }, revision: 'new' }, logId: 'new-log' }));
  const next = await f.available(), newRead = f.featureCommands.get('workspace_contributor.read-provider');
  assert.ok(newRead);
  assert.equal((await newRead.execute({}, next, new AbortController().signal)).logId, 'new-log');
  const status = f.rootCommands.get('workspace_contributor.status');
  assert.ok(status);
  assert.match(JSON.stringify((await status.execute({}, f.context, new AbortController().signal)).data), /"completedReads":1/);
  await f.revoke();
});
