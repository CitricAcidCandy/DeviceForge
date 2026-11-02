import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, ServiceContribution } from '@deviceforge/plugin-sdk';
import { createMarketplace } from '../src/model/index.ts';
import type { MarketplacePublishEntry, MarketplaceStorage } from '../src/model/index.ts';
import { decodeCatalog } from '../src/model/services/catalog.ts';
import { createMarketplacePlugin } from '../src/index.ts';

const signal = () => new AbortController().signal;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const entry: MarketplacePublishEntry = {
  metadata_version: 1, id: 'sample', kind: 'plugin', name: '演示', version: '1.0.0',
  summary: '用途', description: '', keywords: [], categories: ['function'], applies_to: ['deviceforge'],
  supports_mcp: 'none', supports_agent: true, restart_policy: 'none', platforms: ['any'],
  architectures: ['any'], details: { plugin_kind: 'browser' }, visibility: 'market',
};
test('市场模型构造不联网，坏地址不删除原存储，保存失败不偷偷更新当前地址', () => {
  let calls = 0, removes = 0;
  const storage: MarketplaceStorage = {
    getItem: () => 'file:///bad',
    setItem: () => { throw new Error('存储不可写'); },
    removeItem: () => { removes++; },
  };
  const market = createMarketplace(async () => { calls++; return Response.json({}); }, { storage });
  assert.equal(calls, 0); assert.equal(removes, 0);
  assert.equal(market.currentUrl(), 'http://127.0.0.1:7040');
  assert.throws(() => market.setUrl('http://example.com'), /不可写/);
  assert.equal(market.currentUrl(), 'http://127.0.0.1:7040');
  market.dispose();
});
test('市场目录保留元数据问题和内部资源过滤，不通过断言伪造有效条目', () => {
  const catalog = decodeCatalog({ total: 3, entries: [
    entry, { id: 'legacy', kind: 'plugin', name: '旧插件', version: '1', supports_mcp: 'unknown' },
    { ...entry, id: 'internal', visibility: 'internal' },
  ] }, 'http://market.example');
  assert.equal(catalog.entries.length, 2);
  assert.deepEqual(catalog.entries[0]?.metadataIssues, []);
  assert.ok(catalog.entries[1]?.metadataIssues?.some((issue) => issue.includes('MCP')));
});
test('上传与发布走市场原始请求，中文文件名保持，发布响应核对身份', async () => {
  let calls = 0;
  const resource = { id: digest('zip'), sha256: digest('zip'), filename: '演示.zip', media_type: 'application/zip', kind: 'plugin', size: 3, created_at: 1 };
  const market = createMarketplace(async (input, init) => {
    calls++; assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    if (String(input).endsWith('/resources')) {
      assert.equal(decodeURIComponent(new Headers(init?.headers).get('x-resource-filename') ?? ''), '演示.zip');
      return Response.json(resource, { status: 201 });
    }
    return new Response(init?.body, { status: 201, headers: { 'content-type': 'application/json' } });
  }, { storage: null });
  const uploaded = await market.upload(Object.assign(new Blob(['zip']), { name: '演示.zip' }), 'plugin', signal());
  assert.equal(uploaded.id, resource.id);
  const published = await market.publish(entry, signal());
  assert.equal(published.id, 'sample'); assert.equal(calls, 2);
  const wrong = createMarketplace(async () => Response.json({ ...entry, id: 'someone_else' }), { storage: null });
  await assert.rejects(wrong.publish(entry, signal()), /身份不一致/);
  wrong.dispose(); market.dispose();
});
test('资源返回字段与摘要不一致停止交付，下载按条目来源核对原始摘要', async () => {
  const wrong = createMarketplace(async () => Response.json({
    id: digest('a'), sha256: digest('b'), filename: 'a', media_type: 'application/zip', kind: 'plugin', size: 1, created_at: 1,
  }), { storage: null });
  await assert.rejects(wrong.upload(new Blob(['a']), 'plugin', signal()), /字段/);
  let target = '';
  const market = createMarketplace(async (input) => { target = String(input); return new Response('content'); }, { storage: null });
  market.setUrl('http://new-market.example');
  const resource = await market.download(digest('content'), signal(), 'http://original.example');
  assert.equal(target, `http://original.example/api/v1/resources/${digest('content')}`);
  assert.equal(await resource.blob.text(), 'content');
  await assert.rejects(market.download(digest('other'), signal()), /SHA-256/);
  wrong.dispose(); market.dispose();
});
test('市场能力升级提示保留公开错误状态和日志，取消只结束等待不重发', async () => {
  const market = createMarketplace(async () => new Response(null, { status: 404, headers: { 'x-deviceforge-log-id': 'market-log' } }), { storage: null });
  await assert.rejects(market.releaseCapabilities(signal()), (error: unknown) => {
    assert.ok(error instanceof HostError); assert.equal(error.logId, 'market-log');
    assert.equal(error.status, 404); assert.equal(error.code, 'marketplace_upgrade_required'); return true;
  });
  let calls = 0;
  const controller = new AbortController();
  const waiting = createMarketplace(async () => { calls++; return new Promise(() => undefined); }, { storage: null });
  const pending = waiting.search({}, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  market.dispose(); waiting.dispose();
});
test('旧版可选能力缺失时仍保留市场地址服务，不伪造工作区能力', async () => {
  const registered: ServiceContribution[] = [];
  const context: HostContext = {
    apiVersion: 2, signal: signal(), onDispose: (release) => release,
    listOperations: async () => { throw new Error('不应请求操作目录'); }, subscribeOperations: () => () => undefined,
    submit: async () => { throw new Error('不应提交任务'); }, getJob: async () => { throw new Error('不应查询任务'); },
    cancelJob: async () => { throw new Error('不应取消任务'); },
    extensions: {
      register: (value) => { registered.push(...(value.services ?? [])); return () => undefined; },
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: async () => ({ data: null, logId: null }), callService: async () => ({ data: null, logId: null }),
      subscribeEvent: () => () => undefined, emitEvent: () => undefined, getState: () => undefined,
      setState: () => undefined, subscribeState: () => () => undefined,
    },
  };
  await createMarketplacePlugin({ id: 'deviceforge_marketplace', version: '0.1.0' }).activate?.(context);
  assert.equal(registered.length, 1); assert.equal(registered[0]?.id, 'deviceforge_marketplace.preferences');
  const service = registered[0]; assert.ok(service);
  assert.deepEqual((await service.invoke({ action: 'get' }, context, signal())).data, { url: 'http://127.0.0.1:7040' });
  await assert.rejects(service.invoke({ action: 'set', url: 'http://user:secret@market' }, context, signal()), /不含凭证/);
});
