import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplace } from '../src/features/marketplace/index.ts';
import { ApiError } from '../src/services/api/index.ts';

const digest = 'a'.repeat(64);
const capabilities = {
  api_version: 1,
  release_publication: {
    format_versions: [1],
    host_api_versions: [2],
    resource_max_bytes: 2_147_483_648,
    catalog_last: true,
    immutable_versions: true,
  },
};
const signal = () => new AbortController().signal;

test('完整发布查询固定市场并验证能力，请求不携带凭据且拒绝跳转', async () => {
  const requests: string[] = [];
  const controller = new AbortController();
  const market = createMarketplace(async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.signal, controller.signal);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    return Response.json(capabilities);
  });
  market.setUrl('http://new-market.example');
  assert.deepEqual(
    await market.releaseCapabilities(controller.signal, 'http://fixed.example/'),
    capabilities,
  );
  assert.deepEqual(requests, ['http://fixed.example/api/v1/capabilities']);
});

test('缺少能力端点的旧市场明确要求升级，原有 HTTP 状态和日志头保留', async () => {
  for (const status of [404, 405, 501]) {
    const market = createMarketplace(
      async () =>
        new Response(null, {
          status,
          headers: { 'x-deviceforge-log-id': 'capability-log' },
        }),
    );
    await assert.rejects(
      market.releaseCapabilities(signal()),
      (error: unknown) =>
        error instanceof ApiError &&
        error.kind === 'http' &&
        error.code === 'marketplace_upgrade_required' &&
        error.status === status &&
        error.logId === 'capability-log' &&
        /升级市场服务器/.test(error.message),
    );
  }
});

test('缺少完整发布保证、错误版本和非法上限均在能力查询阶段拒绝', async () => {
  const publication = capabilities.release_publication;
  const invalid: unknown[] = [
    null,
    [],
    { api_version: 1 },
    { ...capabilities, api_version: 2 },
    { ...capabilities, release_publication: [] },
    ...[
      { format_versions: [2] },
      { format_versions: [1, 1] },
      { format_versions: ['1'] },
      { host_api_versions: [1] },
      { host_api_versions: [2, 0] },
      { catalog_last: false },
      { immutable_versions: false },
      { catalog_last: 'true' },
      { resource_max_bytes: 0 },
      { resource_max_bytes: -1 },
      { resource_max_bytes: 1.5 },
      { resource_max_bytes: '2147483648' },
      { resource_max_bytes: Number.MAX_SAFE_INTEGER + 1 },
    ].map((override) => ({
      ...capabilities,
      release_publication: { ...publication, ...override },
    })),
  ];
  for (const value of invalid) {
    const market = createMarketplace(async () => Response.json(value));
    await assert.rejects(
      market.releaseCapabilities(signal()),
      (error: unknown) =>
        error instanceof ApiError &&
        error.kind === 'protocol' &&
        error.code === 'marketplace_upgrade_required',
    );
  }
  await assert.rejects(
    createMarketplace(async () => new Response('<html>旧市场</html>')).releaseCapabilities(
      signal(),
    ),
    /升级市场服务器/,
  );
});

test('兼容能力版本列表扩展，资源上限由服务器声明而不硬编码猜测', async () => {
  const value = {
    ...capabilities,
    release_publication: {
      ...capabilities.release_publication,
      format_versions: [1, 2],
      host_api_versions: [2, 3],
      resource_max_bytes: 1024,
    },
  };
  assert.deepEqual(
    await createMarketplace(async () => Response.json(value)).releaseCapabilities(signal()),
    value,
  );
});

test('资源复用仅接受强摘要标记和精确大小，固定来源且仅发 HEAD', async () => {
  const market = createMarketplace(async (input, init) => {
    assert.equal(String(input), `http://fixed.example/api/v1/resources/${digest}`);
    assert.equal(init?.method, 'HEAD');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    return new Response(null, { headers: { etag: `"${digest}"`, 'content-length': '123' } });
  });
  assert.equal(await market.probeResource(digest, 123, signal(), 'http://fixed.example'), true);
});

test('只有资源不存在返回不可复用，服务器失败不伪装为缺失', async () => {
  assert.equal(
    await createMarketplace(async () => new Response(null, { status: 404 })).probeResource(
      digest,
      123,
      signal(),
    ),
    false,
  );
  await assert.rejects(
    createMarketplace(
      async () =>
        new Response(null, {
          status: 503,
          headers: { 'x-deviceforge-log-id': 'head-log', 'retry-after': '5' },
        }),
    ).probeResource(digest, 123, signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.kind === 'http' &&
      error.status === 503 &&
      error.logId === 'head-log' &&
      error.retryAfter === '5',
  );
});

test('ETag 缺失、弱摘要、摘要错配及非精确长度均禁止复用', async () => {
  for (const [etag, length] of [
    ['', '123'],
    [digest, '123'],
    [`W/"${digest}"`, '123'],
    [`"${'b'.repeat(64)}"`, '123'],
    [`"${digest}"`, ''],
    [`"${digest}"`, '124'],
    [`"${digest}"`, '0123'],
    [`"${digest}"`, '1.23e2'],
    [`"${digest}"`, '+123'],
  ]) {
    const headers = new Headers({ 'x-deviceforge-log-id': 'mismatch-log' });
    if (etag) headers.set('etag', etag);
    if (length) headers.set('content-length', length);
    await assert.rejects(
      createMarketplace(async () => new Response(null, { headers })).probeResource(
        digest,
        123,
        signal(),
      ),
      (error: unknown) =>
        error instanceof ApiError && error.kind === 'protocol' && error.logId === 'mismatch-log',
    );
  }
  await assert.rejects(
    createMarketplace(
      async () =>
        new Response(null, {
          status: 206,
          headers: { etag: `"${digest}"`, 'content-length': '123' },
        }),
    ).probeResource(digest, 123, signal()),
    /大小不匹配/,
  );
});

test('无效摘要和大小在发送前拒绝', async () => {
  let calls = 0;
  const market = createMarketplace(async () => {
    calls++;
    return new Response();
  });
  for (const value of ['../bad', 'A'.repeat(64), 'a'.repeat(63)])
    await assert.rejects(market.probeResource(value, 1, signal()), /摘要无效/);
  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(market.probeResource(digest, size, signal()), /大小无效/);
  assert.equal(calls, 0);
});

test('能力查询 HTTP 错误保留结构化错误和日志 ID，网络异常不泄露原始地址', async () => {
  await assert.rejects(
    createMarketplace(async () =>
      Response.json(
        {
          log_id: 'query-log',
          error: { code: 'busy', message: '市场维护中' },
        },
        { status: 503 },
      ),
    ).releaseCapabilities(signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.kind === 'http' &&
      error.code === 'busy' &&
      error.logId === 'query-log' &&
      /市场维护中/.test(error.message),
  );
  await assert.rejects(
    createMarketplace(async () => {
      throw new Error('private-url-and-token');
    }).releaseCapabilities(signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.kind === 'network' &&
      !error.message.includes('private-url-and-token'),
  );
});

test('预先取消不发送请求，在途查询和 HEAD 即使传输忽略信号也结束等待', async () => {
  let calls = 0;
  const cancelled = new AbortController();
  cancelled.abort();
  const market = createMarketplace(async () => {
    calls++;
    return Response.json(capabilities);
  });
  await assert.rejects(market.releaseCapabilities(cancelled.signal), { name: 'AbortError' });
  await assert.rejects(market.probeResource(digest, 1, cancelled.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  for (const probe of [false, true]) {
    const controller = new AbortController();
    let complete: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    const slow = createMarketplace(async () => response);
    const request = probe
      ? slow.probeResource(digest, 123, controller.signal)
      : slow.releaseCapabilities(controller.signal);
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.ok(complete);
    complete(Response.json(capabilities));
  }
});

test('实际资源上传和目录提交保留结构化冲突、日志及重试信息', async () => {
  const market = createMarketplace(async () =>
    Response.json(
      {
        log_id: 'body-log',
        error: { code: 'release_conflict', message: '同版本不能覆盖' },
      },
      { status: 409, headers: { 'x-deviceforge-log-id': 'publish-log', 'retry-after': '3' } },
    ),
  );
  const entry = {
    metadata_version: 1 as const,
    kind: 'plugin' as const,
    id: 'example',
    name: '示例',
    version: '1.0.0',
    summary: '示例',
    description: '示例',
    keywords: [],
    categories: ['function'],
    applies_to: ['deviceforge'],
    supports_mcp: 'none' as const,
    supports_agent: false,
    restart_policy: 'none' as const,
    platforms: [],
    architectures: [],
    resource_id: digest,
    details: {},
  };
  for (const operation of [
    () => market.upload(new File(['content'], '资源.zip'), 'resource', signal()),
    () => market.publish(entry, signal()),
  ]) {
    await assert.rejects(
      operation(),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'release_conflict' &&
        error.logId === 'publish-log' &&
        error.retryAfter === '3' &&
        /同版本不能覆盖/.test(error.message),
    );
  }
});

test('上传与目录提交的传输和响应体等待可取消，迟到失败不成为未处理拒绝', async () => {
  for (const bodyWaiting of [false, true]) {
    const controller = new AbortController();
    let rejectLate: ((error: Error) => void) | undefined;
    const slow = new Promise<Response>((_, reject) => {
      rejectLate = reject;
    });
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* 等待取消测试，不发布字节。 */
      },
    });
    const market = createMarketplace(async () => (bodyWaiting ? new Response(body) : slow));
    const request = market.upload(new File(['content'], '资源.zip'), 'resource', controller.signal);
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    if (!bodyWaiting) rejectLate?.(new Error('迟到网络失败'));
  }
});

test('发布成功响应损坏时保留日志关联，网络失败不暴露底层异常', async () => {
  const file = new File(['content'], '资源.zip');
  await assert.rejects(
    createMarketplace(
      async () =>
        new Response('not-json', {
          headers: { 'x-deviceforge-log-id': 'invalid-json-log' },
        }),
    ).upload(file, 'resource', signal()),
    (error: unknown) =>
      error instanceof ApiError && error.kind === 'protocol' && error.logId === 'invalid-json-log',
  );
  await assert.rejects(
    createMarketplace(async () => {
      throw new Error('private-url-and-token');
    }).upload(file, 'resource', signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.kind === 'network' &&
      !error.message.includes('private-url-and-token'),
  );
});
