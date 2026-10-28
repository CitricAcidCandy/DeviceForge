import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createProductServices } from '../src/app/product/services.ts';
import { localImportDebugUnavailableReason, openImportedPluginDebugger } from '../src/pages/marketplace/local-import/debugger.ts';
import type { ImportedPluginDebugTarget } from '../src/pages/marketplace/local-import/types.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';
import { release } from './plugin-installations-fixture.ts';
import { deferred, installedPackage, requestUrl, signal, success } from './fixtures.ts';

const target: ImportedPluginDebugTarget = { installation: null,
  candidates: [{ kind: 'browser', id: 'local.plugin', version: '1.0.0' }] };
const feature = release(false, '1.0.0', 'b'.repeat(64));
const featureTarget: ImportedPluginDebugTarget = { installation: { id: feature.id, revision: feature.revision },
  candidates: feature.components.map(component => ({ id: component.id, kind: component.kind, version: component.version })) };

async function fixture(options: { readonly tool?: boolean; readonly remote?: boolean; readonly changed?: boolean; readonly firstRead?: Promise<Response> } = {}) {
  const document = new JSDOM('<body></body>').window.document;
  const requests: string[] = [], received: JsonValue[] = [];
  const services = createProductServices({ baseUrl: options.remote ? 'http://192.168.1.12:7031' : 'http://localhost:7031',
    panelTarget: () => null, debugger: { document }, transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      assert.ok(!init?.method || init.method === 'GET', '打开调试器不能写入安装或自动启用插件');
      if (options.firstRead && requests.length === 1) return options.firstRead;
      if (path === '/api/v2/plugin-packages/browser') return success([
        installedPackage('browser', { id: 'local.plugin', version: options.changed ? '2.0.0' : '1.0.0' }),
      ], 'package-directory-log');
      if (path === '/api/v2/plugin-installations') return success([{ ...feature,
        revision: options.changed ? 'c'.repeat(64) : feature.revision,
        installed_at: 1, failure: null, requirements: [], tools: [],
        components: feature.components.map(component => ({ id: component.id, kind: component.kind,
          revision: options.changed ? 'c'.repeat(64) : component.revision, version: component.version,
          entry_path: component.entryPath, entry_url: component.entryUrl })),
      }], 'feature-directory-log');
      throw new Error(`非预期请求：${path}`);
    } });
  if (options.tool !== false) {
    services.runtime.webPlugins.register({ id: 'deviceforge_debugger', trusted: true, plugin: {
      id: 'deviceforge_debugger', version: '0.1.0', apiVersion: 2, panels: [], contributions: { components: [{
        id: 'deviceforge_debugger.floating', title: '调试器', slot: 'developer.tools', mount: async () => () => {},
      }] },
    } });
    await services.runtime.webPlugins.load('deviceforge_debugger');
  }
  const unsubscribe = services.runtime.host.extensions?.subscribeEvent('host.debugger.target_requested', event => { received.push(event.data); });
  return { services, received, requests, async dispose() {
    unsubscribe?.(); await services.dispose(); document.defaultView?.close();
  } };
}

test('导入后只打开本次独立插件的调试候选，不自动启用或创建会话', async () => {
  const f = await fixture();
  try {
    assert.equal(localImportDebugUnavailableReason(f.services), null);
    await openImportedPluginDebugger(f.services, target, signal());
    assert.deepEqual(f.received, [{ candidates: [{ target_kind: 'browser', plugin_id: 'local.plugin' }], installation_id: null }]);
    assert.deepEqual(f.requests, ['GET /api/v2/plugin-packages/browser']);
    assert.equal(f.services.runtime.debugger?.snapshot().instanceId, null);
    assert.equal(f.services.runtime.webPlugins.snapshot().some(item => item.id === 'local.plugin'), false);
  } finally { await f.dispose(); }
});

test('完整发布保留原停用意图和实际安装修订，只带入本次前后端组件', async () => {
  const f = await fixture();
  try {
    await openImportedPluginDebugger(f.services, featureTarget, signal());
    assert.deepEqual(f.requests, ['GET /api/v2/plugin-installations']);
    assert.deepEqual(f.received, [{ installation_id: feature.id, candidates: [
      { target_kind: 'server', plugin_id: 'example-server' }, { target_kind: 'browser', plugin_id: 'example-browser' },
    ] }]);
    assert.equal(f.services.runtime.pluginInstallations.snapshot().result, null, '只读核对不改写市场目录或启停状态');
  } finally { await f.dispose(); }
});

test('导入完成触发市场目录刷新时，不取消正在带入调试器的只读查询', async () => {
  const waiting = deferred<Response>();
  const f = await fixture({ firstRead: waiting.promise });
  try {
    const opening = openImportedPluginDebugger(f.services, target, signal());
    // 原导入成功通知会同时刷新市场目录，不能撤销调试衔接的独立等待。
    await f.services.runtime.pluginPackages.refresh('browser', signal());
    waiting.resolve(success([installedPackage('browser', { id: 'local.plugin', version: '1.0.0' })]));
    await opening;
    assert.equal(f.received.length, 1);
  } finally { waiting.resolve(success([])); await f.dispose(); }
});

test('导入后被并行更新的版本或完整修订拒绝旧目标，并保留目录日志 ID', async () => {
  for (const selected of [target, featureTarget]) {
    const f = await fixture({ changed: true });
    try {
      await assert.rejects(openImportedPluginDebugger(f.services, selected, signal()), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'import_debug_target_changed');
        assert.equal(error.logId, selected.installation ? 'feature-directory-log' : 'package-directory-log');
        return true;
      });
      assert.equal(f.received.length, 0);
    } finally { await f.dispose(); }
  }
});

test('远程连接或调试器停用时说明真实原因，不触发目录或调试请求', async () => {
  for (const options of [{ remote: true }, { tool: false }]) {
    const f = await fixture(options);
    try {
      const reason = localImportDebugUnavailableReason(f.services);
      assert.match(reason ?? '', options.remote ? /本机连接/ : /尚未启用/);
      await assert.rejects(openImportedPluginDebugger(f.services, target, signal()), options.remote ? /本机连接/ : /尚未启用/);
      assert.equal(f.received.length, 0);
      assert.equal(f.requests.length, 0);
    } finally { await f.dispose(); }
  }
});

test('关闭导入窗口撤销后不再打开调试器，空组件不伪造调试成功', async () => {
  const f = await fixture();
  try {
    const caller = new AbortController();
    caller.abort();
    await assert.rejects(openImportedPluginDebugger(f.services, target, caller.signal), { name: 'AbortError' });
    await assert.rejects(openImportedPluginDebugger(f.services, { installation: null, candidates: [] }, signal()), /没有可调试/);
    assert.equal(f.received.length, 0);
    assert.equal(f.requests.length, 0);
  } finally { await f.dispose(); }
});
