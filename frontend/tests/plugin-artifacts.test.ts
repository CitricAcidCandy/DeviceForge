import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { createHostContext } from '../src/app/host-context.ts';
import { createArtifactGateway } from '../src/app/artifact-gateway.ts';
import { createOperations } from '../src/features/operations/index.ts';
import { createTasks } from '../src/features/tasks/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { ArtifactAccess, HostContext, HostResult } from '../src/plugin-sdk/index.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { createApiClient } from '../src/shared/api/index.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

// 响应夹具仅作为未知 HTTP 数据消费，不手写生成 DTO 或调用真实服务。
const metadata = { id: '550e8400-e29b-41d4-a716-446655440000', filename: '字节.json',
  media_type: 'application/json', size: 4, sha256: 'A'.repeat(64), created_at: 123 };
const runtimeOptions = { baseUrl: 'http://localhost:7031', panelTarget: () => null };
function cancelled(error: unknown): boolean {
  assert.ok(error instanceof HostError); assert.equal(error.kind, 'cancelled'); return true;
}

test('API2旧宿主省略产物扩展，作用域不补伪实现；已有createHostContext调用兼容', async () => {
  const client = createApiClient({ ...runtimeOptions, transport: async () => success([]) });
  const operations = createOperations(client); const tasks = createTasks(client);
  const host = createHostContext(operations, tasks, new AbortController());
  const context: HostContext = host.context;
  const scope = createPluginScope(context);
  try {
    assert.equal(context.apiVersion, 2);
    assert.equal(Object.hasOwn(context, 'artifacts'), false);
    assert.equal(Object.hasOwn(scope.context, 'artifacts'), false);
    assert.deepEqual((await scope.context.listOperations(signal())).data, []);
  } finally { await scope.dispose(); await host.dispose(); operations.dispose(); tasks.dispose(); }
});

test('插件公开上传下载保留JSON封套样正文、NUL及非法UTF8原字节和日志，app旧入口形状不变', async () => {
  const payloads = [new TextEncoder().encode('{"log_id":"产物正文","data":{"value":1}}'),
    Uint8Array.of(0, 255, 192, 128, 0, 254)];
  for (const bytes of payloads) {
    const wire = { ...metadata, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    let uploads = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (init?.method === 'POST') {
        ++uploads;
        assert.equal(url.pathname, '/api/v2/artifacts'); assert.equal(url.searchParams.get('filename'), wire.filename);
        const content = init.body; assert.ok(content instanceof Blob);
        assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes);
        assert.equal(new Headers(init.headers).get('content-type'), 'application/octet-stream');
        return success(wire, 'upload-log', 201);
      }
      assert.equal(url.pathname, '/api/v2/artifacts/' + wire.id + '/content');
      return new Response(new Blob([bytes], { type: wire.media_type }),
        { headers: { 'content-type': wire.media_type, 'x-deviceforge-log-id': 'download-log' } });
    };
    const runtime = createFrontendRuntime({ ...runtimeOptions, transport });
    const scope = createPluginScope(runtime.host);
    try {
      const artifacts = scope.context.artifacts; assert.ok(artifacts);
      const uploaded = await artifacts.upload(wire.filename, new Blob([bytes]), signal());
      assert.equal(uploaded.logId, 'upload-log');
      assert.deepEqual(uploaded.data, { id: wire.id, filename: wire.filename, mediaType: wire.media_type,
        size: wire.size, sha256: wire.sha256, createdAt: wire.created_at });
      assert.equal(Object.isFrozen(uploaded.data), true);
      const downloaded = await artifacts.download(uploaded.data.id, signal());
      assert.equal(downloaded.logId, 'download-log'); assert.equal(downloaded.data.type, wire.media_type);
      assert.deepEqual(new Uint8Array(await downloaded.data.arrayBuffer()), bytes);
      const appUploaded = await runtime.artifacts.upload(wire.filename, new Blob([bytes]), signal());
      assert.deepEqual(appUploaded, { data: wire, logId: 'upload-log' });
      assert.equal(Object.hasOwn(appUploaded.data, 'mediaType'), false);
      assert.equal(uploads, 2);
    } finally { await scope.dispose(); await runtime.dispose(); }
  }
});

test('非法公开产物元数据拒绝映射并保留本次日志，不裁剪数字或伪造摘要', async () => {
  const invalid: readonly Record<string, unknown>[] = [
    { id: '' }, { id: '   ' }, { filename: '' }, { filename: '   ' },
    { size: -1 }, { size: 0.5 }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: 'g'.repeat(64) }, { sha256: 'a'.repeat(63) }, { sha256: 'a'.repeat(65) },
    { created_at: -1 }, { created_at: null },
  ];
  let value: unknown = metadata;
  const runtime = createFrontendRuntime({ ...runtimeOptions, transport: async () => success(value, 'metadata-log', 201) });
  try {
    const artifacts = runtime.host.artifacts; assert.ok(artifacts);
    for (const overrides of invalid) {
      value = { ...metadata, ...overrides };
      await assert.rejects(artifacts.upload(metadata.filename, new Blob(), signal()), (error: unknown) => {
        assert.ok(error instanceof HostError); assert.equal(error.kind, 'protocol');
        assert.equal(error.logId, 'metadata-log'); return true;
      });
    }
    value = { ...metadata, size: 0, created_at: 0 };
    const valid = await artifacts.upload(metadata.filename, new Blob(), signal());
    assert.equal(valid.data.size, 0); assert.equal(valid.data.createdAt, 0);
    assert.equal(valid.data.sha256, metadata.sha256);
  } finally { await runtime.dispose(); }
});

test('上传下载HTTP失败映射HostError及真实响应日志，网络失败不生成日志', async () => {
  let unavailable = false;
  const transport: typeof fetch = async () => {
    if (unavailable) throw new Error('模拟传输失败');
    return failure('artifact_missing', 404);
  };
  const runtime = createFrontendRuntime({ ...runtimeOptions, transport });
  try {
    const artifacts = runtime.host.artifacts; assert.ok(artifacts);
    for (const request of [() => artifacts.upload(metadata.filename, new Blob(), signal()),
      () => artifacts.download(metadata.id, signal())]) {
      await assert.rejects(request(), (error: unknown) => {
        assert.ok(error instanceof HostError); assert.equal(error.kind, 'http');
        assert.equal(error.status, 404); assert.equal(error.code, 'artifact_missing');
        assert.equal(error.logId, 'log-error'); return true;
      });
    }
    unavailable = true;
    await assert.rejects(artifacts.download(metadata.id, signal()), (error: unknown) => {
      assert.ok(error instanceof HostError); assert.equal(error.kind, 'network');
      assert.equal(error.logId, null); return true;
    });
  } finally { await runtime.dispose(); }
});

test('预取消或宿主关闭后上传下载零传输，保留的旧公开引用不能再调用', async () => {
  let requests = 0;
  const runtime = createFrontendRuntime({ ...runtimeOptions, transport: async () => { ++requests; return success(metadata); } });
  const artifacts = runtime.host.artifacts; assert.ok(artifacts);
  const caller = new AbortController(); caller.abort();
  try {
    await assert.rejects(artifacts.upload(metadata.filename, new Blob(), caller.signal), cancelled);
    await assert.rejects(artifacts.download(metadata.id, caller.signal), cancelled);
    assert.equal(requests, 0);
    await runtime.dispose();
    await assert.rejects(artifacts.upload(metadata.filename, new Blob(), signal()), cancelled);
    await assert.rejects(artifacts.download(metadata.id, signal()), cancelled);
    assert.equal(requests, 0);
  } finally { await runtime.dispose(); }
});

test('上传下载caller取消及时结束忽略signal的传输等待，迟到响应不交付', { timeout: 5000 }, async () => {
  for (const kind of ['upload', 'download']) {
    const gate = deferred<Response>(); const entered = deferred<AbortSignal>();
    const runtime = createFrontendRuntime({ ...runtimeOptions, transport: async (_input, init) => {
      assert.ok(init?.signal); entered.resolve(init.signal); return gate.promise;
    } });
    const caller = new AbortController();
    try {
      const artifacts = runtime.host.artifacts; assert.ok(artifacts);
      const pending = kind === 'upload' ? artifacts.upload(metadata.filename, new Blob(), caller.signal)
        : artifacts.download(metadata.id, caller.signal);
      const rejected = assert.rejects(pending, cancelled);
      const requestSignal = await entered.promise;
      caller.abort();
      assert.equal(requestSignal.aborted, true);
      await rejected;
    } finally {
      gate.resolve(success(metadata, 'late-response-log', 201));
      await runtime.dispose();
    }
  }
});

test('runtime关闭取消插件在途上传并拒绝后续调用，不声称服务器上传已回滚', { timeout: 5000 }, async () => {
  const gate = deferred<Response>(); const entered = deferred<AbortSignal>(); let requests = 0;
  const runtime = createFrontendRuntime({ ...runtimeOptions, transport: async (_input, init) => {
    ++requests; assert.ok(init?.signal); entered.resolve(init.signal); return gate.promise;
  } });
  const scope = createPluginScope(runtime.host);
  try {
    const artifacts = scope.context.artifacts; assert.ok(artifacts);
    const pending = artifacts.upload(metadata.filename, new Blob(), signal());
    const rejected = assert.rejects(pending, cancelled);
    const requestSignal = await entered.promise;
    await runtime.dispose();
    assert.equal(requestSignal.aborted, true); await rejected;
    await assert.rejects(artifacts.download(metadata.id, signal()), cancelled);
    assert.equal(requests, 1);
  } finally {
    gate.resolve(success(metadata, 'late-upload-log', 201));
    await scope.dispose(); await runtime.dispose();
  }
});

test('宿主网关注入端口忽略取消并晚返回时拒绝成功，保留已取得响应日志', async () => {
  const lifetime = new AbortController(); const entered = deferred<AbortSignal>();
  const gate = deferred<HostResult<Blob>>();
  const artifacts = createArtifactGateway({
    upload: async () => ({ data: metadata, logId: 'unused-upload-log' }),
    download: async (_id, caller) => { entered.resolve(caller); return gate.promise; },
  }, lifetime.signal);
  const pending = artifacts.download(metadata.id, signal());
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HostError); assert.equal(error.kind, 'cancelled');
    assert.equal(error.code, 'stale_result'); assert.equal(error.logId, 'late-content-log'); return true;
  });
  const requestSignal = await entered.promise;
  lifetime.abort(); assert.equal(requestSignal.aborted, true);
  gate.resolve({ data: new Blob(['旧响应']), logId: 'late-content-log' });
  await rejected;
});

test('实际manager卸载取消在途下载，重载同ID建立新引用且旧引用不能复活', { timeout: 5000 }, async () => {
  const gate = deferred<Response>(); const entered = deferred<AbortSignal>();
  let delayed = true; let requests = 0;
  const runtime = createFrontendRuntime({ ...runtimeOptions, transport: async (_input, init) => {
    ++requests;
    if (delayed) { assert.ok(init?.signal); entered.resolve(init.signal); return gate.promise; }
    return new Response('新代产物', { headers: { 'x-deviceforge-log-id': 'new-generation-log' } });
  } });
  const contexts: HostContext[] = [];
  const id = 'artifact_consumer';
  runtime.webPlugins.register({ id, trusted: true, plugin: { id, version: '1.0.0', apiVersion: 2,
    panels: [], async activate(context) { contexts.push(context); },
  } });
  try {
    const before = await runtime.webPlugins.load(id);
    const old = contexts[0]?.artifacts; assert.ok(old);
    const pending = old.download(metadata.id, signal());
    const rejected = assert.rejects(pending, cancelled);
    const requestSignal = await entered.promise;
    await runtime.webPlugins.unload(id);
    assert.equal(requestSignal.aborted, true); await rejected;
    delayed = false;
    const after = await runtime.webPlugins.load(id);
    assert.notEqual(before.generation, after.generation);
    const next = contexts[1]?.artifacts; assert.ok(next);
    assert.notEqual(next, old);
    const content = await next.download(metadata.id, signal());
    assert.equal(content.logId, 'new-generation-log'); assert.equal(await content.data.text(), '新代产物');
    await assert.rejects(old.download(metadata.id, signal()), cancelled);
    assert.equal(requests, 2);
  } finally { gate.resolve(new Response('旧代迟到产物')); await runtime.dispose(); }
});

test('挂载子作用域撤销晚到下载且不关闭兄弟作用域，实例退出后所有旧入口零调用', async () => {
  const runtime = createFrontendRuntime({ ...runtimeOptions, transport: async () => success(metadata) });
  const rootAccess = runtime.host.artifacts; assert.ok(rootAccess);
  const gate = deferred<HostResult<Blob>>(); let delayed = true; let requests = 0;
  let requestSignal: AbortSignal | undefined;
  const upstream: ArtifactAccess = { ...rootAccess, download: async (_id, caller) => {
    ++requests; requestSignal = caller;
    return delayed ? gate.promise : { data: new Blob(['兄弟内容']), logId: 'sibling-log' };
  } };
  const parent = createPluginScope({ ...runtime.host, artifacts: upstream });
  const child = createPluginScope(parent.context); const sibling = createPluginScope(parent.context);
  try {
    const childAccess = child.context.artifacts; const siblingAccess = sibling.context.artifacts;
    assert.ok(childAccess); assert.ok(siblingAccess);
    const pending = childAccess.download(metadata.id, signal());
    const rejected = assert.rejects(pending, cancelled);
    assert.ok(requestSignal);
    child.close(); assert.equal(requestSignal.aborted, true);
    assert.equal(parent.context.signal.aborted, false); assert.equal(sibling.context.signal.aborted, false);
    gate.resolve({ data: new Blob(['退出子作用域的旧内容']), logId: 'late-child-log' });
    await rejected;
    delayed = false;
    const content = await siblingAccess.download(metadata.id, signal());
    assert.equal(await content.data.text(), '兄弟内容');
    assert.equal(content.logId, 'sibling-log');
    parent.close();
    assert.equal(sibling.context.signal.aborted, true);
    await assert.rejects(childAccess.download(metadata.id, signal()), cancelled);
    await assert.rejects(siblingAccess.download(metadata.id, signal()), cancelled);
    assert.equal(requests, 2);
  } finally {
    gate.resolve({ data: new Blob(), logId: null });
    await child.dispose(); await sibling.dispose(); await parent.dispose(); await runtime.dispose();
  }
});
