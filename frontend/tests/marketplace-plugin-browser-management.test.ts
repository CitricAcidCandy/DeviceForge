import test from 'node:test';
import assert from 'node:assert/strict';
import type { HostContext, JsonValue, ServiceAccess } from '../src/plugin-sdk/index.ts';
import {
  BROWSER_MANAGEMENT_SERVICE, browserCatalog, createBrowserManagementClient,
} from '../plugins/marketplace/src/browser-management.ts';

function context(services?: ServiceAccess): HostContext {
  return {
    apiVersion: 2, signal: new AbortController().signal, onDispose: (release) => release,
    listOperations: async () => ({ data: [], logId: null }), subscribeOperations: () => () => undefined,
    submit: async () => { throw new Error('管理客户端不能提交业务'); },
    getJob: async () => { throw new Error('管理客户端不能查询业务'); },
    cancelJob: async () => { throw new Error('管理客户端不能取消业务'); },
    ...(services ? { services } : {}),
  };
}
const empty: JsonValue = {
  snapshotVersion: 1, packages: { known: false, pending: false, entries: [], error: null, logId: null },
  installations: { known: false, pending: false, entries: [], error: null, logId: null },
  runtime: [], bundled: [], clients: [], progress: null, cleanup: [], workspaceCleanup: [],
};
test('市场管理客户端构造不调用宿主，仅经公开版本化服务读取目录', async () => {
  const calls: JsonValue[] = [];
  const client = createBrowserManagementClient(context({
    catalog: () => [], diagnostics: () => [], whenAvailable: () => () => undefined,
    callTyped: async () => { throw new Error('本单元使用公开 JSON 请求'); },
    async call(ref, input, signal) {
      assert.deepEqual(ref, BROWSER_MANAGEMENT_SERVICE);
      signal.throwIfAborted(); calls.push(input);
      return { data: empty, logId: 'catalog-log' };
    },
  }));
  assert.deepEqual(calls, []);
  const result = await client.snapshot(new AbortController().signal);
  assert.equal(result.logId, 'catalog-log');
  assert.equal(result.data.snapshotVersion, 1);
  assert.deepEqual(calls, [{ action: 'snapshot' }]);
});
test('市场管理客户端不把缺能力或不兼容目录伪装成空目录', async () => {
  const client = createBrowserManagementClient(context());
  await assert.rejects(client.snapshot(new AbortController().signal), { code: 'browser_management_unavailable' });
  assert.throws(() => browserCatalog({ ...empty, snapshotVersion: 2 }), { code: 'invalid_browser_catalog' });
  assert.throws(() => browserCatalog({ ...empty, packages: { entries: [] } }), { code: 'invalid_browser_catalog' });
});
test('市场管理客户端的写入失败只交付一次，保留原回执身份', async () => {
  let calls = 0;
  const expected = { kind: 'network', code: 'unknown_write', message: '结果待查询',
    status: null, logId: 'write-log', retryAfter: null };
  const client = createBrowserManagementClient(context({
    catalog: () => [], diagnostics: () => [], whenAvailable: () => () => undefined,
    callTyped: async () => { throw new Error('本单元使用公开 JSON 请求'); },
    async call() { calls++; throw expected; },
  }));
  await assert.rejects(client.request({ action: 'setEnabled', source: 'package', id: 'example', enabled: false },
    new AbortController().signal), (error: unknown) => error === expected);
  assert.equal(calls, 1);
});
