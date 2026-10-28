import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';
import { createDebuggerBuildDirectory } from '../src/app/debugger-builds.ts';
import { createApiClient } from '../src/services/api/index.ts';
import { installedPackage, requestUrl, signal, success } from './fixtures.ts';

function object(value: JsonValue): { [key: string]: JsonValue } {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}

test('公开服务显式重连更换实例、不重放旧调用，未确认不能断开', async () => {
  let registered = 0, disconnected = 0, commands = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    debugger: { document: new JSDOM('<body/>').window.document },
    transport: async input => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/register')) return success({ instance_id: `instance-${++registered}`, plugins: [], active_sessions: 0, idle_ttl_ms: 60000 });
      if (path.endsWith('/heartbeat')) return success({ instance_id: `instance-${registered}`, active_sessions: [], targets: [] });
      if (path.endsWith('/disconnect')) { disconnected++; return success({ disconnected: true }); }
      commands++;
      throw new Error('没有选目标，不应提交调试命令');
    } });
  const call = (value: JsonValue) => runtime.extensions.callService('host.debugger', '1', value, signal());
  try {
    assert.equal(object((await call({ action: 'start' })).data).instance_id, 'instance-1');
    await assert.rejects(call({ action: 'reconnect' }), /显式确认/);
    assert.equal(disconnected, 0);
    assert.equal(object((await call({ action: 'reconnect', input: { confirmed: true } })).data).instance_id, 'instance-2');
    assert.equal(disconnected, 1);
    assert.equal(object(object((await call({ action: 'status' })).data).bridge ?? null).state, 'connected');
    assert.equal(commands, 0);
  } finally { await runtime.dispose(); }
  assert.equal(disconnected, 2);
});

test('日志入口直接查询服务器并保留限制说明、排序和关联ID', async () => {
  const requests: string[] = [];
  const logId = 'e56ea9c3-1090-44cb-8ef1-8ad871f41356';
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    debugger: { document: new JSDOM('<body/>').window.document }, transport: async input => {
      requests.push(requestUrl(input).pathname + requestUrl(input).search);
      return success({ log_id: null, entries: [{ timestamp: '2026-10-28T00:00:00Z', level: 'ERROR',
        message: '第201条之后的服务器记录', log_id: logId, job_id: null, operation: null, code: null, method: null, route: null, status: null }],
      job_ids: [], limited: true }, logId);
    } });
  try {
    const result = await runtime.extensions.callService('host.debugger', '1', { action: 'logs', input: { q: '插件', order: 'desc' } }, signal());
    assert.equal(requests.length, 1);
    const query = new URL(requests[0] ?? '', 'http://127.0.0.1');
    assert.equal(query.pathname, '/api/v2/diagnostics/logs');
    assert.equal(query.searchParams.get('q'), '插件');
    assert.equal(query.searchParams.get('order'), 'desc');
    assert.equal(result.logId, logId);
    assert.equal(object(result.data).limited, true);
  } finally { await runtime.dispose(); }
});

test('同版本新安装修订识别旧页面，旧独立包缺摘要时明确返回未知且不泄露入口路径', async () => {
  const revision = 'b'.repeat(64), old = 'a'.repeat(64);
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:7031', transport: async input => {
    const path = requestUrl(input).pathname;
    if (path === '/api/v2/plugin-installations') return success([{ id: 'example_release', name: '示例', version: '1.0',
      description: '同版本本地构建', revision, enabled: true, status: 'enabled', installed_at: 1,
      components: [{ id: 'example', kind: 'browser', version: '1.0', revision, entry_path: 'private/file.js', entry_url: null }],
      tools: [], requirements: [] }]);
    return success(path.endsWith('/browser') ? [installedPackage('browser', { entry_path: 'private/file.js' })] : []);
  } });
  const query = createDebuggerBuildDirectory(client, () => [{ pluginId: 'example', generation: '12', version: '1.0',
    installationId: 'example_release', revision: old }]);
  const result = await query(signal());
  const text = JSON.stringify(result.data);
  assert.match(text, /refresh_required/);
  assert.match(text, new RegExp(old));
  assert.match(text, /not_provided_by_legacy_package_catalog/);
  assert.doesNotMatch(text, /private\/file|entry_path|entry_url/);
});

test('市场调试请求带入成套组件而不自动选择其他插件，未启用面板给出明确提示', async () => {
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    debugger: { document: new JSDOM('<body/>').window.document },
    transport: async () => { throw new Error('带入候选不应发起调试采集'); } });
  const request: JsonValue = { action: 'focus', input: { installation_id: 'alias_release',
    candidates: [{ target_kind: 'browser', plugin_id: 'alias_browser' }, { target_kind: 'server', plugin_id: 'alias_server' }] } };
  let received: JsonValue | undefined;
  try {
    await assert.rejects(runtime.extensions.callService('host.debugger', '1', request, signal()), /导入并启用官方 Debugger/);
    runtime.webPlugins.register({ id: 'deviceforge_debugger', trusted: true, plugin: {
      id: 'deviceforge_debugger', version: '0.1.0', apiVersion: 2, panels: [],
      contributions: { components: [{ id: 'deviceforge_debugger.tools', slot: 'developer.tools', title: '调试器', mount: async () => () => {} }] },
      activate: async context => { context.extensions?.subscribeEvent('host.debugger.target_requested', event => { received = event.data; }); },
    } });
    await runtime.webPlugins.load('deviceforge_debugger');
    const result = await runtime.extensions.callService('host.debugger', '1', request, signal());
    assert.equal(object(result.data).requested, true);
    assert.deepEqual(received, object(request).input);
    assert.equal(runtime.debugger?.snapshot().activeSessions, 0);
    assert.equal(runtime.debugger?.snapshot().state, 'idle');
  } finally { await runtime.dispose(); }
});
