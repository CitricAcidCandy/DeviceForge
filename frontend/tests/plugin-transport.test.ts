import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTransport } from '../src/app/plugin-transport.ts';
import { scopedTransportAccess } from '../src/plugins/transport-access.ts';
import { HostError } from '../src/plugin-sdk/models.ts';
import type { Dispose, HostResult } from '../src/plugin-sdk/models.ts';
import type { PluginTransport } from '../src/plugin-sdk/transport.ts';
import { createApiClient, withPluginRelease } from '../src/services/api/index.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

function cleanup() {
  const releases = new Set<Dispose>();
  return {
    track: (release: Dispose) => { releases.add(release); return () => { releases.delete(release); return release(); }; },
    release: () => { for (const release of releases) void release(); },
    count: () => releases.size,
  };
}

test('公开 JSON 通路复用客户端并允许新业务路径，令牌逐次读取且不进入结果', async () => {
  const seen: RequestInit[] = [];
  let token = 'first';
  const transport = createPluginTransport(createApiClient({
    baseUrl: 'http://localhost:7031', tokenProvider: () => token,
    transport: async (url, init) => {
      assert.equal(requestUrl(url).pathname, '/api/v2/plugin-new-business/query');
      seen.push(init ?? {});
      return success({ value: 3 });
    },
  }));
  assert.deepEqual(await transport.request({ path: '/api/v2/plugin-new-business/query' }, signal()), { data: { value: 3 }, logId: 'log-test' });
  token = 'second';
  await transport.request({ path: '/api/v2/plugin-new-business/query', method: 'POST', body: { value: 9 } }, signal());
  assert.equal(new Headers(seen[0]?.headers).get('authorization'), 'Bearer first');
  assert.equal(new Headers(seen[1]?.headers).get('authorization'), 'Bearer second');
  assert.equal(seen[1]?.body, '{"value":9}');
});

test('上传原字节后仍可拆解 v2 JSON；raw JSON 与字节读取不误拆包装', async () => {
  const content = new Blob(['原始包字节']);
  const transport = createPluginTransport(createApiClient({
    baseUrl: 'http://localhost:7031', transport: async (url, init) => {
      if (requestUrl(url).pathname.endsWith('/upload')) {
        assert.equal(init?.body, content);
        assert.equal(new Headers(init?.headers).get('content-type'), 'application/zip');
        return success({ accepted: true });
      }
      return Response.json({ log_id: 'resource', data: '保留原结构' }, { headers: { 'x-deviceforge-log-id': 'raw-log' } });
    },
  }));
  assert.deepEqual((await transport.request({ path: '/api/v2/upload', method: 'POST', content, contentType: 'application/zip' }, signal())).data, { accepted: true });
  assert.deepEqual((await transport.request({ path: '/api/v2/resource', envelope: 'raw' }, signal())).data, { log_id: 'resource', data: '保留原结构' });
  const result = await transport.bytes({ path: '/api/v2/resource' }, signal());
  assert.equal(result.logId, 'raw-log');
  assert.deepEqual(JSON.parse(await result.data.text()), { log_id: 'resource', data: '保留原结构' });
});

test('原始请求经过既有发布修订包装且不丢 Accept 与日志', async () => {
  const api = withPluginRelease(createApiClient({
    baseUrl: 'http://localhost:7031', transport: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('accept'), 'application/octet-stream');
      assert.deepEqual(JSON.parse(headers.get('x-deviceforge-plugin-release') ?? '{}'), { id: 'bundle', revision: 'a'.repeat(64) });
      return new Response(new Uint8Array([0, 255, 128]), { headers: { 'x-deviceforge-log-id': 'bytes-log' } });
    },
  }), { id: 'bundle', revision: 'a'.repeat(64) });
  const result = await createPluginTransport(api).bytes({ path: '/api/v2/resource', headers: { accept: 'application/octet-stream' } }, signal());
  assert.deepEqual(new Uint8Array(await result.data.arrayBuffer()), new Uint8Array([0, 255, 128]));
  assert.equal(result.logId, 'bytes-log');
});

test('HTTP 错误保留代码、日志和退避元数据，不自动重发', async () => {
  let calls = 0;
  const transport = createPluginTransport(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => {
    calls++;
    const response = failure('conflict', 429);
    response.headers.set('retry-after', '3');
    return response;
  } }));
  for (const invoke of [() => transport.request({ path: '/api/v2/new' }, signal()), () => transport.bytes({ path: '/api/v2/new' }, signal())]) {
    await assert.rejects(invoke(), (error: unknown) => error instanceof HostError && error.code === 'conflict' && error.logId === 'log-error' && error.retryAfter === '3' && error.status === 429);
  }
  assert.equal(calls, 2);
});

test('请求边界拒绝越界路径、保留头、冲突正文及无效期限，不调用网络', async () => {
  let calls = 0;
  const transport = createPluginTransport(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => { calls++; return success(null); } }));
  for (const path of ['https://other.test/api/v2/new', '//other.test/api/v2/new', '/api/v2/../private', '/api/v2/%2e%2e/private', '/api/v2/a%2fb', '/api/v1/new', '/api/v2/new#part'])
    await assert.rejects(transport.request({ path }, signal()), (error: unknown) => error instanceof HostError && error.code === 'invalid_transport_path');
  await assert.rejects(transport.request({ path: '/api/v2/new', headers: { Authorization: 'bad' } }, signal()), /凭据/);
  await assert.rejects(transport.request({ path: '/api/v2/new', method: 'POST', body: {}, content: new Blob() }, signal()), /同时提供/);
  await assert.rejects(transport.request({ path: '/api/v2/new', timeoutMs: 0 }, signal()), /期限/);
  assert.equal(calls, 0);
});

test('传输忽略取消时公开等待仍收敛，超时不宣称后台任务终止', async () => {
  const pending = deferred<Response>();
  const transport = createPluginTransport(createApiClient({ baseUrl: 'http://localhost:7031', transport: () => pending.promise }));
  const keepAlive = setTimeout(() => undefined, 200);
  try {
    await assert.rejects(transport.request({ path: '/api/v2/new', timeoutMs: 5 }, signal()), (error: unknown) => error instanceof HostError && error.code === 'request_timeout' && error.message.includes('另行查询'));
  } finally { clearTimeout(keepAlive); pending.resolve(success(null)); }
});

test('作用域撤销收敛忽略取消的上游，晚到流会被回收', async () => {
  const pending = deferred<HostResult<ReadableStream<Uint8Array>>>();
  let cancelled = 0;
  const scope = new AbortController();
  const releases = cleanup();
  const upstream: PluginTransport = {
    request: async () => ({ data: null, logId: null }),
    bytes: async () => ({ data: new Blob(), logId: null }),
    stream: () => pending.promise,
  };
  const access = scopedTransportAccess(upstream, scope.signal, releases.track);
  assert.ok(access);
  const result = access.stream({ path: '/api/v2/new' }, signal());
  await Promise.resolve();
  scope.abort();
  await assert.rejects(result, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
  pending.resolve({ data: new ReadableStream({ cancel() { cancelled++; } }), logId: 'late' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(releases.count(), 0);
});

test('作用域撤销真实取消活动流，旧数据不可继续读取', async () => {
  let cancelled = 0;
  const scope = new AbortController();
  const releases = cleanup();
  const transport = createPluginTransport(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers: { 'x-deviceforge-log-id': 'stream-log' } }) }));
  const access = scopedTransportAccess(transport, scope.signal, releases.track);
  assert.ok(access);
  const result = await access.stream({ path: '/api/v2/stream' }, signal());
  const reader = result.data.getReader();
  const next = reader.read();
  scope.abort();
  await assert.rejects(next, (error: unknown) => error instanceof HostError && error.logId === 'stream-log');
  await Promise.resolve();
  assert.equal(cancelled, 1);
  assert.equal(releases.count(), 0);
});

test('正常流按字节结束并释放作用域登记，不残留取消监听', async () => {
  const releases = cleanup();
  const transport = createPluginTransport(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => new Response(new Uint8Array([3, 4])) }));
  const access = scopedTransportAccess(transport, signal(), releases.track);
  assert.ok(access);
  const result = await access.stream({ path: '/api/v2/stream' }, signal());
  const reader = result.data.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([3, 4]));
  assert.equal((await reader.read()).done, true);
  assert.equal(releases.count(), 0);
});
