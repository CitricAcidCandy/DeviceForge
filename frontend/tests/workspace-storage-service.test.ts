import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { JsonValue } from '../src/plugin-sdk/models.ts';

const object = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const ref = { id: 'host.workspace.storage', version: '1' };
const signal = () => new AbortController().signal;
const options = {
  baseUrl: 'http://127.0.0.1:7031',
  panelTarget: () => null,
  transport: async () => { throw new Error('存储服务不应发起网络请求'); },
};

test('外壳经公开版本服务读取真实布局持久性，禁用时不宣称已保存', async () => {
  const runtime = createFrontendRuntime({ ...options, workspaceStorage: null });
  try {
    assert.ok(runtime.host.services);
    const result = await runtime.host.services.call(ref, { action: 'status' }, signal());
    assert.deepEqual(result.data, {
      enabled: false, state: 'unavailable', source: 'unavailable', pending: false, lastError: null,
    });
    await assert.rejects(runtime.host.services.call(ref, { action: 'saveCurrent' }, signal()), /未启用/);
  } finally { await runtime.dispose(); }
});

test('损坏布局由公开服务查询，显式保存才覆盖，重读不自动写入', async () => {
  const storage = memoryStorage();
  const key = 'deviceforge:workspaces:v1:http://127.0.0.1:7031';
  storage.setItem(key, '{invalid');
  const runtime = createFrontendRuntime({ ...options, workspaceStorage: storage });
  try {
    assert.ok(runtime.host.services);
    const state = await runtime.host.services.call(ref, { action: 'status' }, signal());
    assert.ok(object(state.data));
    assert.equal(state.data.state, 'blocked');
    const reread = await runtime.host.services.call(ref, { action: 'retryRead' }, signal());
    assert.equal(typeof reread.data, 'object');
    assert.equal(storage.getItem(key), '{invalid');
    const saved = await runtime.host.services.call(ref, { action: 'saveCurrent' }, signal());
    assert.ok(object(saved.data));
    assert.equal(saved.data.state, 'ready');
    assert.notEqual(storage.getItem(key), '{invalid');
  } finally { await runtime.dispose(); }
});

test('布局服务拒绝额外字段和未知动作，不把未知请求当成保存', async () => {
  const runtime = createFrontendRuntime({ ...options, workspaceStorage: memoryStorage() });
  try {
    const services = runtime.host.services;
    assert.ok(services);
    await assert.rejects(async () => services.call(ref, { action: 'status', overwrite: true }, signal()), /请求|输入|契约|schema/i);
    await assert.rejects(async () => services.call(ref, { action: 'unknown' }, signal()), /请求|输入|契约|schema/i);
  } finally { await runtime.dispose(); }
});
