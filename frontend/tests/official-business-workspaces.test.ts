import './official-business-imports.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginManager } from '../src/plugins/manager.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue, Operation } from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';

const { default: frida } = await import('../plugins/frida/src/index.ts');
const { default: automation } = await import('../plugins/automation/src/index.ts');
const { default: analysis } = await import('../plugins/analysis/src/index.ts');
const { default: performance } = await import('../plugins/performance/src/index.ts');
const { createOperationSource, createPublicGateway } = await import('../plugins/business-kit/src/platform.ts');
const { ApiError } = await import('../plugins/business-kit/src/api/index.ts');
const { createDexAnalysis } = await import('../plugins/analysis/src/dex-analysis/index.ts');

function context(changes: Partial<HostContext> = {}): HostContext {
  return {
    apiVersion: 2, signal: new AbortController().signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('登记工作区不能提交业务'); },
    getJob: async () => { throw new Error('登记工作区不能查询任务'); },
    cancelJob: async () => { throw new Error('登记工作区不能取消任务'); },
    subscribeOperations: () => () => {}, onDispose: () => () => {},
    ...changes,
  };
}

test('四个独立业务插件只登记工作区，启停撤销页面且保留用户布局', async () => {
  let reads = 0;
  const manager = createPluginManager({
    host: context({ listOperations: async () => { reads++; return { data: [], logId: null }; } }),
    panelTarget: () => null,
  });
  const definitions = [
    frida({ id: 'deviceforge_frida', version: '1', apiVersion: 2 }),
    automation({ id: 'deviceforge_automation', version: '1', apiVersion: 2 }),
    analysis({ id: 'deviceforge_analysis', version: '1', apiVersion: 2 }),
    performance({ id: 'deviceforge_performance', version: '1', apiVersion: 2 }),
  ];
  try {
    for (const plugin of definitions) {
      manager.register({ id: plugin.id, trusted: true, plugin });
      await manager.load(plugin.id);
    }
    const workspaces = manager.extensions.workspaces;
    assert.deepEqual(workspaces.catalog().pages.map((page) => page.route).sort(),
      ['/analysis', '/automation', '/frida', '/performance']);
    assert.equal(reads, 0);
    assert.equal(workspaces.snapshot().instances.filter((item) => item.state === 'ready').length, 4);
    const layout = workspaces.hostAccess().readLayout('deviceforge_frida.workspace');
    const generation = workspaces.resolveView('deviceforge_frida.main.default')?.instance.snapshot().generation ?? 0;
    await manager.unload('deviceforge_frida');
    assert.equal(workspaces.catalog().pages.length, 3);
    assert.deepEqual(workspaces.hostAccess().readLayout('deviceforge_frida.workspace'), layout);
    assert.equal(workspaces.snapshot().instances.find((item) => item.instanceId === 'deviceforge_frida.main.default')?.reason, 'owner_inactive');
    await manager.load('deviceforge_frida');
    assert.ok((workspaces.resolveView('deviceforge_frida.main.default')?.instance.snapshot().generation ?? 0) > generation);
    workspaces.hostAccess().writeLayout('deviceforge_frida.workspace', {
      version: 1, root: null, floating: [], overlays: [],
    });
    await manager.unload('deviceforge_frida');
    await manager.load('deviceforge_frida');
    assert.equal(workspaces.hostAccess().readLayout('deviceforge_frida.workspace')?.root, null);
    assert.equal(workspaces.resolveView('deviceforge_frida.main.default'), null);
  } finally { await manager.dispose(); }
});

test('公开操作目录查询晚到隔离，独立监听异常不阻断其他消费者', async () => {
  const pending = deferred<{ data: readonly Operation[]; logId: string | null }>();
  let calls = 0, releases = 0, observed = 0;
  const source = createOperationSource(context({
    listOperations: async () => ++calls === 1 ? pending.promise : { data: [], logId: 'new-log' },
    subscribeOperations: () => () => { releases++; },
  }));
  source.subscribe(() => { throw new Error('单个消费者异常'); });
  source.subscribe(() => { observed++; });
  try {
    const first = source.list(new AbortController().signal);
    const discarded = assert.rejects(first, ApiError);
    await source.list(new AbortController().signal);
    pending.resolve({ data: [{ id: 'old', title: '旧目录', input_schema: {} }], logId: 'old-log' });
    await discarded;
    assert.equal(source.snapshot().result?.logId, 'new-log');
    assert.equal(source.snapshot().result?.data.length, 0);
    assert.ok(observed > 0);
  } finally { source.dispose(); }
  assert.equal(releases, 1);
});

test('公开任务适配保留 HostError 的真实日志与状态，不自动重放', async () => {
  let submitted = 0;
  const gateway = createPublicGateway(context({
    submit: async () => {
      submitted++;
      throw new HostError('http', 'revision_conflict', '当前数据已变化', 'original-log', 409);
    },
  }));
  await assert.rejects(gateway.submit('plugin.example.write', {}, new AbortController().signal),
    (error: unknown) => error instanceof ApiError && error.logId === 'original-log' && error.status === 409);
  assert.equal(submitted, 1);
});

test('独立 DEX 模型消费公开操作与 Job，目录撤销后不回退内置能力', async () => {
  const source = '12345678-1234-1234-1234-123456789abc';
  let available = true, submitted = 0;
  const result: JsonValue = {
    artifact_id: source, version: '040', file_size: 512,
    counts: { strings: 8, types: 5, prototypes: 1, fields: 2, methods: 3, defined_classes: 4 },
    integrity: { artifact_sha256: true, dex_sha1: true, dex_adler32: true },
  };
  const model = createDexAnalysis({
    submit: async (operation) => {
      submitted++;
      return {
        data: { id: 'dex-job', operation, status: 'succeeded', result: { result, artifacts: [] }, error: null },
        logId: 'dex-log',
      };
    },
    getJob: async () => { throw new Error('终态不应轮询'); },
    cancelJob: async () => { throw new Error('不可自动取消'); },
  }, {
    list: async () => ({
      data: available ? [{ id: 'plugin.dex-analysis.inspect', title: 'DEX', input_schema: { type: 'object' } }] : [],
      logId: 'directory-log',
    }),
  });
  try {
    await model.refreshOperations(new AbortController().signal);
    const inspected = await model.inspect({ artifact_id: source }, new AbortController().signal);
    assert.equal(inspected.data.version, '040');
    assert.equal(inspected.logId, 'dex-log');
    available = false;
    await model.refreshOperations(new AbortController().signal);
    assert.throws(() => model.inspect({ artifact_id: source }, new AbortController().signal), ApiError);
    assert.equal(submitted, 1);
  } finally { model.dispose(); }
});
