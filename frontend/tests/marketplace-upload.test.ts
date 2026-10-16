import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplace } from '../src/features/marketplace/services/index.ts';
import {
  createMarketplacePublishEntry,
  initialMarketplaceUploadDraft,
} from '../src/pages/marketplace/upload.ts';

test('市场上传先提交原始资源，再发布带摘要的 market.json', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const resource = {
    id: 'a'.repeat(64),
    sha256: 'a'.repeat(64),
    filename: 'demo.zip',
    media_type: 'application/zip',
    kind: 'plugin',
    size: 3,
    created_at: 1,
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/v1/resources'))
      return new Response(JSON.stringify(resource), { status: 201 });
    assert.equal(url, 'http://market.example/api/v1/catalog');
    return new Response(init.body, {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const marketplace = createMarketplace(fetcher);
  marketplace.setUrl('http://market.example');
  const file = Object.assign(new Blob(['zip']), { name: 'demo.zip' });
  const uploaded = await marketplace.upload(file, 'plugin', new AbortController().signal);
  assert.equal(uploaded.sha256, resource.sha256);
  const draft = {
    ...initialMarketplaceUploadDraft,
    id: 'demo-plugin',
    name: '演示插件',
    summary: '演示上传',
  };
  const entry = createMarketplacePublishEntry(draft, uploaded.sha256);
  await marketplace.publish(entry, new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(new Headers(calls[0]!.init.headers).get('x-resource-kind'), 'plugin');
  assert.equal(new Headers(calls[0]!.init.headers).get('x-resource-filename'), 'demo.zip');
  assert.equal(calls[1]!.init.method, 'POST');
  assert.equal(JSON.parse(String(calls[1]!.init.body)).resource_id, resource.sha256);
});

test('市场上传元数据在发送前校验标识和专属描述', () => {
  const draft = { ...initialMarketplaceUploadDraft, id: 'Bad ID', name: '演示', summary: '摘要' };
  assert.throws(() => createMarketplacePublishEntry(draft, 'sha256'), /条目标识/);
  assert.throws(
    () => createMarketplacePublishEntry({ ...draft, id: 'demo', details: '[]' }, 'sha256'),
    /JSON 对象/,
  );
  assert.throws(
    () =>
      createMarketplacePublishEntry(
        { ...draft, id: 'demo', kind: 'resource', visibility: 'market' },
        'sha256',
      ),
    /内部可见性/,
  );
});
