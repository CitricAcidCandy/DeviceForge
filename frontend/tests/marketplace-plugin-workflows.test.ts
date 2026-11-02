import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { ApiError } from '@deviceforge/plugin-sdk';
import type { HostResult, JsonValue } from '@deviceforge/plugin-sdk';
import { marketContext } from '../plugins/marketplace/tests/context.ts';
import { createMarketplaceApi } from '../plugins/marketplace/src/workbench/api/client.ts';
import { createInstalledCatalog } from '../plugins/marketplace/src/workbench/installed.ts';
import { createMarketplaceConfigurations } from '../plugins/marketplace/src/workbench/configuration.ts';
import { decodeUiDirectory } from '../plugins/marketplace/src/workbench/ui-directory.ts';
import { createMarketplaceServices } from '../plugins/marketplace/src/workbench/services.ts';
import { createMarketplace } from '../plugins/marketplace/src/model/index.ts';
import { localImportPorts, previewLocalImport, submitLocalImportWithResult } from '../plugins/marketplace/src/workbench/local-import/actions.ts';
import { openImportedPluginDebugger } from '../plugins/marketplace/src/workbench/local-import/debugger.ts';
import { marketplaceQuery } from '../plugins/marketplace/src/workbench/query.ts';

const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
function directory(version: string): HostResult<JsonValue> {
  return { logId: 'browser-catalog', data: {
    snapshotVersion: 1,
    packages: { known: true, pending: false, error: null, logId: null, entries: [{
      id: 'sample', version, kind: 'browser', installed_at: 1, runtime: 'esm', entry_path: 'index.js',
    }] },
    installations: { known: true, pending: false, entries: [], error: null, logId: null },
    runtime: [], bundled: [], clients: [], progress: null, cleanup: [], workspaceCleanup: [],
  } };
}
test('安装目录观察忽略旧快照晚到，取消和销毁撤销自有订阅', async () => {
  const late = deferred<HostResult<JsonValue>>();
  let version = '1.0.0', oldSnapshot = false;
  const context = marketContext({
    request: async () => ({ data: [], logId: null }),
    call: async (input) => {
      if (input && typeof input === 'object' && !Array.isArray(input) && input.action === 'snapshot' && oldSnapshot)
        return late.promise;
      return directory(version);
    },
  });
  const model = createInstalledCatalog(context, createMarketplaceApi(context));
  assert.equal(context.listenerCount(), 0);
  await model.refresh(signal());
  assert.equal(model.snapshot().browser?.packages[0]?.version, '1.0.0');
  oldSnapshot = true; context.emitHostEvent('host.browser-plugins.changed'); await tick();
  version = '2.0.0'; oldSnapshot = false;
  await model.refresh(signal());
  late.resolve(directory('0.9.0')); await tick();
  assert.equal(model.snapshot().browser?.packages[0]?.version, '2.0.0');
  assert.equal(model.snapshot().known, true);
  assert.equal(context.listenerCount(), 1);
  await model.dispose();
  assert.equal(context.listenerCount(), 0);
});
test('界面目录不复制槽位白名单，未知和未挂载保持可区分，拒绝带私有实例目标的回执', () => {
  const value = { snapshotVersion: 1, revision: 1,
    slots: { known: false, entries: [] }, points: { known: true, definitions: [], contributions: [] },
    ui: { known: true, catalog: { pages: [], workspaces: [], views: [] }, instances: [] } };
  assert.equal(decodeUiDirectory(value, null).slots.known, false);
  assert.deepEqual(decodeUiDirectory({
    ...value, slots: { known: true, entries: [{ id: 'independent.custom', modes: ['append'], ready: false }] },
  }, null).slots.entries[0], { id: 'independent.custom', modes: ['append'], ready: false });
  assert.throws(() => decodeUiDirectory({ ...value, ui: { ...value.ui, instances: [{
    instanceId: 'i', pluginId: 'owner', workspaceId: 'w', provider: null, visible: true,
    generation: 1, providerGeneration: null, state: 'unselected', reason: 'provider_unselected', target: { secret: 'private' },
  }] } }, 'private-log'), { code: 'invalid_marketplace_ui_directory', logId: 'private-log' });
});
test('浏览器配置保存冲突保留原修订与调用方草稿，不重放保存或自动应用', async () => {
  const calls: JsonValue[] = [], draft = { name: '尚未保存' };
  const conflict = new ApiError('http', 'configuration_conflict', '原修订已变化', 409, 'conflict-log');
  const context = marketContext({ call: async (input) => { calls.push(input); throw conflict; } });
  const configurations = createMarketplaceConfigurations(context, createMarketplaceApi(context));
  await assert.rejects(configurations.save({ kind: 'browser', id: 'sample' }, 'opaque-r1', draft, signal()),
    (error) => error === conflict);
  assert.deepEqual(draft, { name: '尚未保存' });
  assert.deepEqual(calls, [{ action: 'configuration', operation: 'save', id: 'sample', revision: 'opaque-r1', values: draft }]);
});
test('导入后调试先重读版本，目标变化时不打开调试器，匹配后只调用一次 focus', async () => {
  let current = '2.0.0', focus = 0;
  const context = marketContext({ debuggerAvailable: true,
    request: async () => ({ data: [{ id: 'sample', version: current, kind: 'browser', runtime: 'esm', entry_path: 'index.js', installed_at: 1 }], logId: 'target-read' }),
    call: async (input) => {
      focus++; assert.deepEqual(input, { action: 'focus', input: {
        candidates: [{ target_kind: 'browser', plugin_id: 'sample' }], installation_id: null,
      } });
      return { data: null, logId: 'focus-log' };
    },
  });
  const marketplace = createMarketplace(async () => { throw new Error('不应访问市场'); }, { storage: null });
  const services = createMarketplaceServices(context, marketplace);
  const target = { installation: null, candidates: [{ kind: 'browser' as const, id: 'sample', version: '1.0.0' }] };
  await assert.rejects(openImportedPluginDebugger(services, target, signal()),
    { code: 'import_debug_target_changed', logId: 'target-read' });
  assert.equal(focus, 0);
  current = '1.0.0'; await openImportedPluginDebugger(services, target, signal());
  assert.equal(focus, 1);
  await services.dispose(); marketplace.dispose();
});
test('完整发布预览固定原修订，确认导入按原修订更新并保留停用意图', async () => {
  const bytes = zipSync({ 'readme.txt': new TextEncoder().encode('paired') });
  const file = new File([new Uint8Array(bytes).buffer], 'paired.zip', { type: 'application/zip' });
  const digest = createHash('sha256').update(bytes).digest('hex'), calls: unknown[] = [];
  const marketplace = createMarketplace(async () => { throw new Error('不应访问市场'); }, { storage: null });
  const services = createMarketplaceServices(marketContext(), marketplace);
  const current = { id: 'paired', name: '配套插件', description: '', summary: '', version: '1.0.0',
    revision: 'a'.repeat(64), enabled: false, status: 'installed' as const,
    components: [{ id: 'sample', kind: 'browser' as const, version: '1.0.0', revision: 'a'.repeat(64), entryPath: 'index.js', entryUrl: null }] };
  const ports = { ...localImportPorts(services),
    installations: {
      refresh: async () => ({ data: [current], logId: 'preview-log' }),
      install: async () => { throw new Error('已有安装不能改走新装'); },
      async update(id: string, revision: string, source: JsonValue) {
        calls.push([id, revision, source]); return { ...current, version: '2.0.0', revision: 'b'.repeat(64) };
      },
    },
    installationArtifacts: { upload: async () => ({ data: {
      id: 'artifact', filename: file.name, media_type: file.type, size: file.size, sha256: digest, created_at: 1,
    }, logId: 'artifact-log' }) },
  };
  const preview = await previewLocalImport(ports, { kind: 'plugin', file, manifest: null, moduleId: '' }, signal(),
    async () => ({ files: [], excluded: [], totalSize: bytes.byteLength, metadata: null, identity: null,
      release: { id: 'paired', name: '配套插件', version: '2.0.0', componentCount: 1, toolCount: 0 } }));
  assert.equal(preview.kind, 'release');
  if (preview.kind !== 'release') throw new Error('必须进入完整发布流程');
  assert.equal(preview.expectedRevision, current.revision);
  const result = await submitLocalImportWithResult(ports, preview, signal());
  assert.deepEqual(calls, [['paired', current.revision, { kind: 'offline', artifactId: 'artifact' }]]);
  assert.match(result.message, /保持停用/u);
  assert.equal(result.debugTarget?.installation?.revision, 'b'.repeat(64));
  await services.dispose(); marketplace.dispose();
});
test('市场筛选统一回第一页，保留 false、零偏移和分页大小', () => {
  assert.deepEqual(marketplaceQuery({ kind: 'plugin', q: '', supports_agent: false, offset: 0, limit: 24 }),
    { kind: 'plugin', supports_agent: false, offset: 0, limit: 24 });
  assert.deepEqual(marketplaceQuery({ supports_mcp: 'unknown', restart_policy: 'invalid', offset: -1 }), {});
});

test('目录读取忽略取消时，调用方停止等待仍会收敛且不重放刷新', async () => {
  let reads = 0;
  const context = marketContext({
    request: async () => ({ data: [], logId: null }),
    call: async () => { reads++; return new Promise(() => undefined); },
  });
  const model = createInstalledCatalog(context, createMarketplaceApi(context)), caller = new AbortController();
  const pending = model.refresh(caller.signal);
  assert.equal(model.snapshot().pending, true);
  caller.abort();
  await assert.rejects(pending, (error) => error instanceof ApiError && error.kind === 'cancelled');
  assert.equal(model.snapshot().pending, false);
  assert.equal(model.snapshot().known, false);
  assert.equal(reads, 1);
  await model.dispose();
  assert.equal(context.listenerCount(), 0);
});

test('目录订阅同步失败保留本次错误，后续独立模型仍可读取', async () => {
  const base = marketContext({ request: async () => ({ data: [], logId: null }), call: async () => directory('1.0.0') });
  const extensions = base.extensions; assert.ok(extensions);
  const unavailable = new Error('本次事件订阅不可用');
  const broken = { ...base, extensions: { ...extensions, subscribeEvent() { throw unavailable; } } };
  const model = createInstalledCatalog(broken, createMarketplaceApi(broken));
  await assert.rejects(model.refresh(signal()), (error) => error === unavailable);
  assert.equal(model.snapshot().pending, false);
  assert.equal(model.snapshot().error, unavailable);
  const independent = createInstalledCatalog(base, createMarketplaceApi(base));
  await independent.refresh(signal());
  assert.equal(independent.snapshot().known, true);
  await model.dispose(); await independent.dispose();
});
