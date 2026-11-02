import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@deviceforge/plugin-sdk';
import { createMarketplaceApi } from '../plugins/marketplace/src/workbench/api/client.ts';
import { createMarketplacePackages } from '../plugins/marketplace/src/workbench/packages.ts';
import { packagesEndpoint } from '../plugins/marketplace/src/workbench/api/index.ts';
import { marketContext } from '../plugins/marketplace/tests/context.ts';

const signal = () => new AbortController().signal;
const pkg = { id: 'sample', kind: 'browser', version: '2.0.0', installed_at: 1, runtime: 'esm', entry_path: 'index.js' };
test('市场公开 HTTP 适配构造不联网，目录校验失败保留原日志', async () => {
  let requests = 0;
  const client = createMarketplaceApi(marketContext({ request: async (input) => {
    requests++; assert.equal(input.path, '/api/v2/plugin-packages/browser');
    return { data: { bad: true }, logId: 'catalog-log' };
  } }));
  assert.equal(requests, 0);
  await assert.rejects(client.call(packagesEndpoint, 'browser', signal()),
    { code: 'invalid_marketplace_management_result', logId: 'catalog-log' });
  assert.equal(requests, 1);
});
test('浏览器包先上传原产物再调用公开管理服务，不绕过本地来源撤销', async () => {
  const calls: unknown[] = [];
  const context = marketContext({
    request: async () => { throw new Error('浏览器包不能直接改服务器文件'); },
    upload: async (name, content, active) => {
      active.throwIfAborted(); calls.push(['upload', name, content.size]);
      return { data: { id: 'artifact-id', size: content.size, sha256: 'a'.repeat(64),
        filename: name, mediaType: 'application/zip', createdAt: 1 }, logId: 'upload-log' };
    },
    call: async (input) => { calls.push(input); return { data: { completed: true, result: pkg }, logId: 'package-log' }; },
  });
  const packages = createMarketplacePackages(context, createMarketplaceApi(context));
  const result = await packages.update('browser', 'sample', new Blob(['zip']), 'application/zip', signal(), '2.0.0');
  assert.equal(result.logId, 'package-log');
  assert.equal(result.data.id, 'sample');
  assert.deepEqual(calls, [
    ['upload', 'sample.zip', 3],
    { action: 'package', operation: 'update', id: 'sample', artifactId: 'artifact-id',
      mediaType: 'application/zip', version: '2.0.0' },
  ]);
});
test('市场单包回执身份不符和未知写入都不重放操作', async () => {
  let calls = 0;
  const failure = new ApiError('network', 'unknown', '写入结果未确认', null, 'unknown-log');
  const context = marketContext({ call: async () => { calls++; throw failure; } });
  const packages = createMarketplacePackages(context, createMarketplaceApi(context));
  await assert.rejects(packages.remove('browser', 'sample', signal()), (error) => error === failure);
  assert.equal(calls, 1);
  const wrong = marketContext({ call: async () => ({
    data: { completed: true, result: { ...pkg, id: 'other' } }, logId: 'wrong-log',
  }) });
  await assert.rejects(createMarketplacePackages(wrong, createMarketplaceApi(wrong)).remove('browser', 'sample', signal()),
    { code: 'marketplace_package_identity_mismatch', logId: 'wrong-log' });
});
