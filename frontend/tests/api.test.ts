import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, installPackageEndpoint, jobEndpoint, operationsEndpoint, pluginsEndpoint, submitEndpoint, uploadEndpoint } from '../src/services/api/index.ts';
import { deferred, failure, job, plugin, requestUrl, signal, success } from './fixtures.ts';

test('在线包上传按生成契约发送唯一必填 format，原始 Blob 和媒体类型保持一致', () => {
  const content = new Blob(['包原始字节']);
  const zip = installPackageEndpoint.request({ kind: 'browser', content, mediaType: 'application/zip' });
  const tgz = installPackageEndpoint.request({ kind: 'server', content, mediaType: 'application/gzip' });
  assert.equal(zip.path, '/api/v2/plugin-packages/browser?format=zip');
  assert.equal(tgz.path, '/api/v2/plugin-packages/server?format=tgz');
  assert.equal(zip.body, content); assert.equal(tgz.body, content);
  assert.equal(zip.contentType, 'application/zip'); assert.equal(tgz.contentType, 'application/gzip');
  assert.equal(zip.method, 'POST'); assert.equal(tgz.method, 'POST');
});

test('v2 数组/对象拆包保留日志 ID，令牌仅在请求头且可逐次变更', async () => {
  let currentToken = 'first';
  const seen: { url: URL; init: RequestInit | undefined }[] = [];
  const api = createApiClient({
    baseUrl: 'http://127.0.0.1:7031', tokenProvider: () => currentToken,
    transport: async (url, init) => {
      seen.push({ url: requestUrl(url), init });
      return requestUrl(url).pathname.endsWith('operations') ? success([{ id: 'example.run', title: '运行', input_schema: {} }]) : success(job());
    },
  });
  assert.equal((await api.call(operationsEndpoint, undefined, signal())).data[0]?.id, 'example.run');
  currentToken = 'second';
  const result = await api.call(submitEndpoint, { operation: 'example.run', input: { value: 1 } }, signal());
  assert.equal(result.data.status, 'queued'); assert.equal(result.logId, 'log-test');
  assert.equal(new Headers(seen[0]?.init?.headers).get('authorization'), 'Bearer first');
  assert.equal(new Headers(seen[1]?.init?.headers).get('authorization'), 'Bearer second');
  assert.equal(seen[1]?.init?.redirect, 'error'); assert.equal(seen[1]?.init?.credentials, 'omit');
  assert.ok(seen.every((entry) => !entry.url.search && !entry.url.username));
});

test('本地免鉴权缺省不发送 Authorization，公开标识按路径段编码', async () => {
  const api = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (url, init) => {
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.equal(requestUrl(url).pathname, '/api/v2/jobs/a%2Fb%3Ftoken%3Dx');
    return success(job());
  } });
  await api.call(jobEndpoint, 'a/b?token=x', signal());
  await assert.rejects(api.call(jobEndpoint, '..', signal()), /路径跳转/);
});

test('401/429 与 cleanup_failed 错误受控传播，不自动重试', async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const api = createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => {
      ++calls;
      const response = failure(status === 401 ? 'unauthorized' : 'rate_limited', status);
      response.headers.set('retry-after', '3'); return response;
    } });
    await assert.rejects(api.call(operationsEndpoint, undefined, signal()), (error: unknown) => {
      assert.ok(error instanceof ApiError); assert.equal(error.kind, 'http'); assert.equal(error.status, status);
      assert.equal(error.logId, 'log-error'); assert.equal(error.retryAfter, '3'); return true;
    });
    assert.equal(calls, 1);
  }
});

test('损坏包装、错误业务结构和不一致日志头被拒绝，保留可用日志 ID', async () => {
  for (const response of [
    Response.json({ log_id: 'body-only', data: [{ id: 'missing-title' }] }),
    Response.json({ data: [] }),
    Response.json({ log_id: 'other', data: [] }, { headers: { 'x-deviceforge-log-id': 'header-id' } }),
    new Response('损坏 JSON', { headers: { 'x-deviceforge-log-id': 'parse-id' } }),
  ]) {
    const api = createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => response });
    await assert.rejects(api.call(operationsEndpoint, undefined, signal()), (error: unknown) => {
      assert.ok(error instanceof ApiError); assert.equal(error.kind, 'protocol');
      if (error.message.includes('业务响应')) assert.equal(error.logId, 'body-only');
      return true;
    });
  }
});

test('服务端 cleanup_failed 必須存在且为布尔值，状态不被隐藏', async () => {
  const api = createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => success([plugin({ cleanup_failed: true, state: 'draining' })]) });
  const result = await api.call(pluginsEndpoint, undefined, signal());
  assert.equal(result.data[0]?.cleanup_failed, true); assert.equal(result.data[0]?.state, 'draining');
  const wrong = createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => success([{ ...plugin(), cleanup_failed: 'false' }]) });
  await assert.rejects(wrong.call(pluginsEndpoint, undefined, signal()), /生成契约/);
});

test('原始 JSON 产物保持原字节，上传使用 octet-stream 与独立文件名参数', async () => {
  const raw = ' {"data":"文件正文","log_id":"内容字段"}\n';
  const bytes = new Blob([raw], { type: 'application/json' });
  const api = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(init.body, bytes);
      assert.equal(new Headers(init.headers).get('content-type'), 'application/octet-stream');
      assert.equal(requestUrl(url).searchParams.get('filename'), '中文 & #.json');
      return success({ id: 'artifact', filename: '中文 & #.json', media_type: 'application/json', size: bytes.size, sha256: 'hash', created_at: 1 }, 'upload-log', 201);
    }
    return new Response(raw, { headers: { 'content-type': 'application/json', 'x-deviceforge-log-id': 'download-log' } });
  } });
  const upload = await api.call(uploadEndpoint, { filename: '中文 & #.json', content: bytes }, signal());
  assert.equal(upload.logId, 'upload-log');
  const download = await api.downloadArtifact('artifact', signal());
  assert.equal(await download.data.text(), raw); assert.equal(download.logId, 'download-log');
});

test('取消令牌等待或忽略信号的传输仍及时结束，晚到拒绝不泄漏', async () => {
  const token = deferred<string>();
  let requests = 0;
  const first = new AbortController();
  const api = createApiClient({ baseUrl: 'http://localhost:7031', tokenProvider: () => token.promise, transport: async () => { ++requests; return success([]); } });
  const waiting = api.call(operationsEndpoint, undefined, first.signal);
  first.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  token.resolve('late'); assert.equal(requests, 0);
  const response = deferred<Response>(); const entered = deferred<void>(); const second = new AbortController();
  const other = createApiClient({ baseUrl: 'http://localhost:7031', transport: () => { entered.resolve(); return response.promise; } });
  const pending = other.call(operationsEndpoint, undefined, second.signal);
  await entered.promise; second.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  response.reject(new Error('晚到传输错误'));
});

test('网络异常不泄露传输原文，取消前不调用令牌提供器', async () => {
  const api = createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => { throw new Error('secret-token/private-path'); } });
  await assert.rejects(api.call(operationsEndpoint, undefined, signal()), (error: unknown) => {
    assert.ok(error instanceof ApiError); assert.equal(error.kind, 'network'); assert.doesNotMatch(error.message, /secret|private/); return true;
  });
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(api.call(operationsEndpoint, undefined, stopped.signal), (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
});
