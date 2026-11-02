import test from 'node:test';
import assert from 'node:assert/strict';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { CleanupContext, Dispose, HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createReleaseHost } from '../src/app/release-host.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { createApiClient } from '../src/services/api/index.ts';
import { failure, requestUrl, success } from './fixtures.ts';

test('真实管理器卸载和换代各清理一次，旧句柄不影响新代且不留下根资源错误', async () => {
  const paths: string[] = [], contexts: HostContext[] = [], releases: Dispose[] = [];
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async (input) => { paths.push(requestUrl(input).pathname); return success({ released: true }); },
  });
  const plugin: WebPlugin = { id: 'resource_owner', version: '1', apiVersion: 2, panels: [], async activate(context) {
    contexts.push(context); assert.ok(context.onCleanup);
    const generation = contexts.length;
    releases.push(context.onCleanup(async (cleanup) => {
      assert.equal(context.signal.aborted, true); assert.ok(cleanup.transport);
      await cleanup.transport.request({ path: `/api/v2/owned/${generation}/release`, method: 'POST' }, cleanup.signal);
    }));
  } };
  try {
    runtime.webPlugins.register({ id: plugin.id, trusted: true, plugin });
    await runtime.webPlugins.load(plugin.id); await runtime.webPlugins.unload(plugin.id);
    assert.deepEqual(paths, ['/api/v2/owned/1/release']);
    await runtime.webPlugins.load(plugin.id);
    await releases[0]?.();
    assert.deepEqual(paths, ['/api/v2/owned/1/release']);
    await runtime.webPlugins.unload(plugin.id);
    assert.deepEqual(paths, ['/api/v2/owned/1/release', '/api/v2/owned/2/release']);
    assert.equal(runtime.webPlugins.cleanupSnapshot().length, 0);
  } finally { await runtime.dispose(); }
});

test('整个运行时撤销后仍完成已登记的限时资源释放，普通入口保持关闭', async () => {
  let calls = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { calls++; return success(null); },
  });
  let released = false;
  const plugin: WebPlugin = { id: 'owner', version: '1', apiVersion: 2, panels: [], async activate(context) {
    assert.ok(context.onCleanup);
    context.onCleanup(async (cleanup) => {
      assert.equal(runtime.host.signal.aborted, true);
      assert.equal(context.signal.aborted, true);
      assert.equal(cleanup.signal.aborted, false); assert.ok(cleanup.transport);
      await cleanup.transport.request({ path: '/api/v2/owned/release', method: 'POST' }, cleanup.signal);
      released = true;
    });
  } };
  runtime.webPlugins.register({ id: plugin.id, trusted: true, plugin });
  await runtime.webPlugins.load(plugin.id); await runtime.dispose();
  assert.equal(released, true); assert.equal(calls, 1);
  assert.ok(runtime.host.transport);
  await assert.rejects(runtime.host.transport.request({ path: '/api/v2/owned/new' }, new AbortController().signal));
  assert.equal(calls, 1);
});

test('插件清理失败保留历史而不污染根或阻止同插件新代', async () => {
  let calls = 0, generation = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { calls++; return calls === 1 ? failure('release_unknown', 503) : success(null); },
  });
  const plugin: WebPlugin = { id: 'recoverable', version: '1', apiVersion: 2, panels: [], async activate(context) {
    generation++; assert.ok(context.onCleanup);
    context.onCleanup(async (cleanup) => {
      assert.ok(cleanup.transport);
      await cleanup.transport.request({ path: '/api/v2/owned/release', method: 'POST' }, cleanup.signal);
    });
  } };
  try {
    runtime.webPlugins.register({ id: plugin.id, trusted: true, plugin });
    await runtime.webPlugins.load(plugin.id);
    await assert.rejects(runtime.webPlugins.unload(plugin.id));
    assert.equal(calls, 1);
    const history = runtime.webPlugins.cleanupSnapshot(); assert.equal(history.length, 1);
    await runtime.webPlugins.load(plugin.id); assert.equal(generation, 2);
    await runtime.webPlugins.unload(plugin.id); assert.equal(calls, 2);
    assert.deepEqual(runtime.webPlugins.cleanupSnapshot(), history);
  } finally { await runtime.dispose(); }
});

test('独立发布的普通及清理请求保留固定修订，释放后句柄不可继续发请求', async () => {
  const headers: Headers[] = [], contexts: CleanupContext[] = [];
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('本单元只读取固定发布的模拟连接'); },
  });
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:7031', transport: async (_input, init) => {
    headers.push(new Headers(init?.headers)); return success(null);
  } });
  const revision = { id: 'independent_release', revision: 'f'.repeat(64) };
  const host = createReleaseHost(runtime.host, client, revision, runtime.tasks, runtime.devices);
  const scope = createPluginScope(host);
  try {
    assert.ok(scope.context.transport && scope.context.onCleanup);
    await scope.context.transport.request({ path: '/api/v2/owned/query' }, scope.context.signal);
    scope.context.onCleanup(async (cleanup) => {
      contexts.push(cleanup); assert.ok(cleanup.transport);
      await cleanup.transport.request({ path: '/api/v2/owned/release', method: 'POST' }, cleanup.signal);
    });
    await scope.dispose(); assert.equal(headers.length, 2);
    for (const header of headers)
      assert.deepEqual(JSON.parse(header.get('x-deviceforge-plugin-release') ?? '{}'), revision);
    const cleanup = contexts[0]; assert.ok(cleanup?.transport);
    await assert.rejects(cleanup.transport.request({ path: '/api/v2/owned/release' }, new AbortController().signal),
      (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    assert.equal(headers.length, 2);
  } finally { await scope.dispose(); await runtime.dispose(); }
});
