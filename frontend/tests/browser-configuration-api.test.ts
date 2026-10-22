import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserConfigurationPersistence } from '../src/features/plugin-configurations/index.ts';
import { createApiClient } from '../src/services/api/index.ts';
import {
  browserPluginConfigurationEndpoint,
  patchBrowserPluginConfigurationEndpoint,
  isBrowserConfigurationRecord,
  isBrowserConfigurationView,
} from '../src/services/api/browser-plugin-configuration.ts';
import { failure, signal, success } from './fixtures.ts';

function record() {
  return {
    version: 1,
    values: { count: 2 },
    revision: 'defaults',
    applied: 'defaults',
    sensitivePaths: ['/secret'],
  };
}

test('浏览器配置 decoder 接受空记录和完整记录，拒绝非对象值及损坏元数据', () => {
  const valid = record();
  assert.equal(isBrowserConfigurationView({ record: null }), true);
  assert.equal(isBrowserConfigurationView({ record: valid }), true);
  assert.equal(isBrowserConfigurationView({}), false);
  assert.equal(isBrowserConfigurationView({ record: undefined }), false);
  for (const values of [
    null,
    3,
    '配置',
    [],
    [1],
    { invalid: Number.NaN },
    { invalid: undefined },
  ]) {
    assert.equal(isBrowserConfigurationRecord({ ...valid, values }), false);
  }
  for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x100000000]) {
    assert.equal(isBrowserConfigurationRecord({ ...valid, version }), false);
  }
  for (const changes of [
    { revision: '' },
    { applied: '' },
    { sensitivePaths: ['secret'] },
    { sensitivePaths: [null] },
  ]) {
    assert.equal(isBrowserConfigurationRecord({ ...valid, ...changes }), false);
  }
  assert.equal(
    isBrowserConfigurationRecord({
      version: valid.version,
      values: valid.values,
      revision: valid.revision,
      applied: valid.applied,
    }),
    false,
  );
});

test('浏览器配置端点编码插件标识，PATCH 明确携带 CAS 及完整记录', () => {
  const id = 'example/中文?x=1';
  const path = '/api/v2/browser-plugin-configurations/example%2F%E4%B8%AD%E6%96%87%3Fx%3D1';
  assert.deepEqual(browserPluginConfigurationEndpoint.request(id), { path, method: 'GET' });
  const body = { expected_revision: null, record: record() };
  assert.deepEqual(patchBrowserPluginConfigurationEndpoint.request({ id, body }), {
    path,
    method: 'PATCH',
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  assert.throws(() => browserPluginConfigurationEndpoint.request('..'), /路径跳转/);
});

test('浏览器配置公共客户端拒绝损坏业务响应并保留真实日志 ID', async () => {
  const client = createApiClient({
    baseUrl: 'http://localhost:7031',
    transport: async () => success({ record: { ...record(), values: [] } }, 'invalid-record-log'),
  });
  const persistence = createBrowserConfigurationPersistence(client);
  await assert.rejects(persistence.get('example', signal()), {
    kind: 'protocol',
    code: 'invalid_response',
    status: 200,
    logId: 'invalid-record-log',
  });
  await assert.rejects(persistence.save('example', null, record(), signal()), {
    kind: 'protocol',
    code: 'invalid_response',
    status: 200,
    logId: 'invalid-record-log',
  });
});

test('GET 空记录可读取，PATCH 返回空记录不能伪报保存成功', async () => {
  const persistence = createBrowserConfigurationPersistence(
    createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => success({ record: null }),
    }),
  );
  assert.equal(await persistence.get('example', signal()), null);
  await assert.rejects(persistence.save('example', null, record(), signal()), /未返回.*配置记录/);
});

test('GET 和 PATCH 的失败沿公共客户端保留错误码、状态与日志 ID', async () => {
  const persistence = createBrowserConfigurationPersistence(
    createApiClient({
      baseUrl: 'http://localhost:7031',
      transport: async () => failure('configuration_conflict', 409),
    }),
  );
  await assert.rejects(persistence.get('example', signal()), {
    kind: 'http',
    code: 'configuration_conflict',
    status: 409,
    logId: 'log-error',
  });
  await assert.rejects(persistence.save('example', 'defaults', record(), signal()), {
    kind: 'http',
    code: 'configuration_conflict',
    status: 409,
    logId: 'log-error',
  });
});
