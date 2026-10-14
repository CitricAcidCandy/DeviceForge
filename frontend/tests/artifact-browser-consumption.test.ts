import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactBrowser, createHttpArtifactBrowser } from '../src/features/artifact-browser/index.ts';
import type { ArtifactBrowserGateway } from '../src/features/artifact-browser/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ApiResult, ArchiveEntries, ArtifactMetadata } from '../src/services/api/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const first = '12345678-1234-1234-1234-123456789abc';
const second = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function metadata(changes: Partial<ArtifactMetadata> = {}): ArtifactMetadata {
  return { id: first, filename: '应用.apk', media_type: 'application/zip', size: 123, sha256: 'a'.repeat(64), created_at: 1, ...changes };
}
function entry(name = 'AndroidManifest.xml') { return { name, size: 10, compressed_size: 5, directory: false }; }
function page(changes: Partial<ArchiveEntries> = {}): ArchiveEntries { return { total: 3, entries: [entry()], next_offset: 1, ...changes }; }
function gateway(changes: Partial<ArtifactBrowserGateway> = {}): ArtifactBrowserGateway {
  return {
    metadata: async (id) => ({ data: metadata({ id }), logId: 'metadata-log' }),
    entries: async () => ({ data: page(), logId: 'entries-log' }),
    remove: async (id) => ({ data: metadata({ id }), logId: 'remove-log' }),
    ...changes,
  };
}

test('HTTP工厂复用v2生成端点，规范UUID与查询参数保留各请求日志', async () => {
  const urls: string[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input) => {
    const url = requestUrl(input); urls.push(url.pathname + url.search);
    return url.pathname.endsWith('/entries') ? success(page(), 'entries-log') : success(metadata(), 'metadata-log');
  } });
  const browser = createHttpArtifactBrowser(client);
  await browser.select(first.toUpperCase(), signal());
  const result = await browser.page({ offset: 0, limit: 1 }, signal());
  assert.equal(result.logId, 'entries-log');
  assert.deepEqual(urls, [`/api/v2/artifacts/${first}`, `/api/v2/artifacts/${first}/entries?offset=0&limit=1`]);
  assert.equal(browser.snapshot().metadataLogId, 'metadata-log');
  assert.equal(browser.snapshot().entriesLogId, 'entries-log');
  browser.dispose();
});

test('删除复用v2 DELETE端点，成功清除当前选择并保留删除日志', async () => {
  const urls: { path: string; method: string }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input, init) => {
    const url = requestUrl(input); urls.push({ path: url.pathname, method: init?.method ?? 'GET' });
    return success(metadata(), 'remove-log');
  } });
  const browser = createHttpArtifactBrowser(client);
  await browser.select(first, signal());
  const result = await browser.remove(first.toUpperCase(), signal());
  assert.equal(result.data.id, first);
  assert.equal(result.logId, 'remove-log');
  assert.deepEqual(urls, [
    { path: `/api/v2/artifacts/${first}`, method: 'GET' },
    { path: `/api/v2/artifacts/${first}`, method: 'DELETE' },
  ]);
  assert.equal(browser.snapshot().selection, null);
  assert.equal(browser.snapshot().removeLogId, 'remove-log');
  browser.dispose();
});

test('删除冲突保留当前元数据和真实错误日志，非法身份不发请求', async () => {
  let requests = 0;
  const browser = createArtifactBrowser(gateway({ remove: async () => {
    requests++;
    throw new ApiError('http', 'conflict', '产物仍被读取', 409, 'remove-conflict-log');
  } }));
  await browser.select(first, signal());
  await assert.rejects(browser.remove(first, signal()), (error: unknown) => error instanceof ApiError && error.code === 'conflict' && error.logId === 'remove-conflict-log');
  assert.equal(requests, 1);
  assert.equal(browser.snapshot().selection, first);
  assert.equal(browser.snapshot().metadata?.id, first);
  assert.equal(browser.snapshot().removeLogId, 'remove-conflict-log');
  assert.equal(browser.snapshot().error?.code, 'conflict');
  assert.throws(() => browser.remove('C:/产物.apk', signal()), ApiError);
  assert.equal(requests, 1);
  browser.dispose();
});

test('删除在途时切换选择会撤销旧请求，晚到结果不能清空新选择', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<ArtifactMetadata>>();
  const browser = createArtifactBrowser(gateway({ remove: async () => { entered.resolve(); return blocked.promise; } }));
  await browser.select(first, signal());
  const waiting = browser.remove(first, signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  await browser.select(second, signal()); await rejected;
  blocked.resolve({ data: metadata(), logId: 'late-remove-log' });
  assert.equal(browser.snapshot().selection, second);
  assert.equal(browser.snapshot().metadata?.id, second);
  assert.equal(browser.snapshot().removeLogId, null);
  browser.dispose();
});

test('默认分页、目录项与重复名称保留原顺序，末尾空页合法', async () => {
  const seen: unknown[] = [];
  const browser = createArtifactBrowser(gateway({ entries: async (id, query) => {
    seen.push({ id, query });
    return { data: query.offset === 3 ? page({ entries: [], next_offset: null }) : page({ entries: [entry('same'), { ...entry('dir/'), directory: true }, entry('same')], next_offset: null }), logId: 'entries-log' };
  } }));
  await browser.select(first, signal());
  const result = await browser.page({}, signal());
  assert.deepEqual(result.data.entries.map((item) => item.name), ['same', 'dir/', 'same']);
  assert.equal((await browser.page({ offset: 3 }, signal())).data.entries.length, 0);
  assert.deepEqual(seen[0], { id: first, query: { offset: 0, limit: 50 } });
  browser.dispose();
});

test('输入身份、未知分页字段、非法偏移和页长在请求前拒绝', async () => {
  let requests = 0;
  const browser = createArtifactBrowser(gateway({ entries: async () => { requests++; return { data: page(), logId: 'entries-log' }; } }));
  assert.throws(() => browser.select('C:/input.apk', signal()), ApiError);
  assert.throws(() => browser.page({}, signal()), ApiError);
  await browser.select(first, signal());
  for (const offset of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => browser.page({ offset }, signal()), ApiError);
  for (const limit of [0, 201, 1.5, Infinity]) assert.throws(() => browser.page({ limit }, signal()), ApiError);
  const extra = { offset: 0, limit: 1, path: 'C:/input' };
  assert.throws(() => browser.page(extra, signal()), ApiError);
  assert.equal(requests, 0);
  browser.dispose();
});

test('非ZIP选择可看元数据，不能发目录请求', async () => {
  let requests = 0;
  const browser = createArtifactBrowser(gateway({ metadata: async () => ({ data: metadata({ media_type: 'application/json', filename: '数据.json' }), logId: 'metadata-log' }), entries: async () => { requests++; return { data: page(), logId: 'entries-log' }; } }));
  await browser.select(first, signal());
  assert.throws(() => browser.page({}, signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_not_archive');
  assert.equal(requests, 0);
  browser.dispose();
});

test('错误元数据身份或摘要形状拒绝并保留响应日志', async () => {
  for (const value of [metadata({ id: second }), metadata({ sha256: 'broken' }), metadata({ size: Number.MAX_SAFE_INTEGER + 1 }), metadata({ created_at: -1 })]) {
    const browser = createArtifactBrowser(gateway({ metadata: async () => ({ data: value, logId: 'bad-metadata-log' }) }));
    await assert.rejects(browser.select(first, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'bad-metadata-log');
    assert.equal(browser.snapshot().metadata, null);
    browser.dispose();
  }
});

test('页长度、总数和next_offset不一致不能发布成功页', async () => {
  for (const value of [page({ total: -1 }), page({ total: 0 }), page({ entries: [] }), page({ next_offset: null }), page({ next_offset: 2 }), page({ entries: [entry(), entry()] }), { total: 3, entries: [entry()] }, page({ entries: [{ ...entry(), compressed_size: 1.5 }] })]) {
    const browser = createArtifactBrowser(gateway({ entries: async () => ({ data: value, logId: 'bad-page-log' }) }));
    await browser.select(first, signal());
    await assert.rejects(browser.page({ limit: 1 }, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'bad-page-log');
    assert.equal(browser.snapshot().page, null);
    browser.dispose();
  }
});

test('响应建立冻结副本，网关后续修改不能改变快照', async () => {
  const sourceMetadata = metadata();
  const sourcePage = page();
  const browser = createArtifactBrowser(gateway({ metadata: async () => ({ data: sourceMetadata, logId: 'metadata-log' }), entries: async () => ({ data: sourcePage, logId: 'entries-log' }) }));
  await browser.select(first, signal());
  await browser.page({ limit: 1 }, signal());
  sourceMetadata.filename = 'changed.apk'; sourcePage.entries[0] = entry('changed');
  const snapshot = browser.snapshot();
  assert.equal(snapshot.metadata?.filename, '应用.apk');
  assert.equal(snapshot.page?.entries[0]?.name, 'AndroidManifest.xml');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.metadata), true);
  assert.equal(Object.isFrozen(snapshot.page?.entries), true);
  assert.equal(Object.isFrozen(snapshot.page?.entries[0]), true);
  browser.dispose();
});

test('选择切换及时撤销忽略信号的旧元数据，晚到不能覆盖新选择', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<ArtifactMetadata>>();
  const browser = createArtifactBrowser(gateway({ metadata: async (id) => {
    if (id === first) { entered.resolve(); return blocked.promise; }
    return { data: metadata({ id, filename: 'second.apk' }), logId: 'second-log' };
  } }));
  const waiting = browser.select(first, signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  await browser.select(second, signal()); await rejected;
  blocked.resolve({ data: metadata(), logId: 'late-log' });
  assert.equal(browser.snapshot().selection, second);
  assert.equal(browser.snapshot().metadata?.filename, 'second.apk');
  assert.equal(browser.snapshot().metadataLogId, 'second-log');
  browser.dispose();
});

test('新页清空旧页并撤销旧请求，查询参数副本不受调用者修改影响', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<ArchiveEntries>>();
  const seen: unknown[] = [];
  const browser = createArtifactBrowser(gateway({ entries: async (_id, query) => {
    seen.push(query);
    if (seen.length === 2) { entered.resolve(); return blocked.promise; }
    return { data: seen.length === 1 ? page() : page({ entries: [entry('last')], next_offset: null }), logId: 'page-log' };
  } }));
  await browser.select(first, signal());
  await browser.page({ limit: 1 }, signal());
  const query = { offset: 1, limit: 1 };
  const waiting = browser.page(query, signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  query.offset = 2;
  assert.equal(browser.snapshot().page, null);
  await browser.page({ offset: 2, limit: 1 }, signal()); await rejected;
  blocked.resolve({ data: page({ next_offset: 2 }), logId: 'late-log' });
  assert.deepEqual(seen[1], { offset: 1, limit: 1 });
  assert.equal(browser.snapshot().page?.entries[0]?.name, 'last');
  browser.dispose();
});

test('换产物选择撤销在途目录，旧目录不能出现在新产物下', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<ArchiveEntries>>();
  const browser = createArtifactBrowser(gateway({ entries: async () => { entered.resolve(); return blocked.promise; } }));
  await browser.select(first, signal());
  const waiting = browser.page({ limit: 1 }, signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  await browser.select(second, signal()); await rejected;
  blocked.resolve({ data: page(), logId: 'old-entries-log' });
  assert.equal(browser.snapshot().selection, second);
  assert.equal(browser.snapshot().metadata?.id, second);
  assert.equal(browser.snapshot().page, null);
  assert.equal(browser.snapshot().entriesLogId, null);
  browser.dispose();
});

test('目录失败保留元数据和真实错误，旧页不能复活', async () => {
  let requests = 0;
  const browser = createArtifactBrowser(gateway({ entries: async () => {
    requests++;
    if (requests === 2) throw new ApiError('http', 'preview_busy', '目录并发已满', 409, 'busy-log');
    return { data: page(), logId: 'page-log' };
  } }));
  await browser.select(first, signal()); await browser.page({ limit: 1 }, signal());
  await assert.rejects(browser.page({ limit: 1 }, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'busy-log');
  assert.equal(browser.snapshot().metadata?.id, first);
  assert.equal(browser.snapshot().metadataLogId, 'metadata-log');
  assert.equal(browser.snapshot().page, null);
  assert.equal(browser.snapshot().error?.code, 'preview_busy');
  browser.dispose();
});

test('预取消不请求，clear与销毁撤销旧等待且禁止销毁后调用', async () => {
  let requests = 0;
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<ArtifactMetadata>>();
  const browser = createArtifactBrowser(gateway({ metadata: async () => { requests++; entered.resolve(); return blocked.promise; } }));
  const controller = new AbortController(); controller.abort();
  assert.throws(() => browser.select(first, controller.signal), (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  assert.equal(requests, 0);
  const waiting = browser.select(first, signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise; browser.clear(); await rejected;
  assert.equal(browser.snapshot().selection, null);
  browser.dispose();
  assert.throws(() => browser.select(second, signal()), ApiError);
  blocked.reject(new Error('晚到拒绝已被消费'));
});

test('caller取消与销毁撤销在途页，即使网关不合作也结束等待', async () => {
  for (const action of ['abort', 'dispose']) {
    const entered = deferred<void>();
    const blocked = deferred<ApiResult<ArchiveEntries>>();
    const browser = createArtifactBrowser(gateway({ entries: async () => { entered.resolve(); return blocked.promise; } }));
    await browser.select(first, signal());
    const controller = new AbortController();
    const waiting = browser.page({ limit: 1 }, controller.signal);
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    await entered.promise;
    if (action === 'abort') controller.abort(); else browser.dispose();
    await rejected;
    blocked.resolve({ data: page(), logId: 'late-log' });
    assert.equal(browser.snapshot().page, null);
    assert.equal(browser.snapshot().loading, null);
    browser.dispose();
  }
});

test('订阅重入clear撤销旧发布，坏订阅不阻塞有效订阅', async () => {
  const browser = createArtifactBrowser(gateway());
  const observed: string[] = [];
  browser.subscribe((state) => { if (state.metadata) browser.clear(); });
  browser.subscribe(() => { throw new Error('订阅错误'); });
  browser.subscribe((state) => { if (state.metadata) observed.push(state.metadata.id); });
  await assert.rejects(browser.select(first, signal()), (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'metadata-log');
  assert.deepEqual(observed, []);
  assert.equal(browser.snapshot().selection, null);
  browser.dispose();
});

test('HTTP畸形元数据和目录项由shared拒绝并保留v2响应日志', async () => {
  const metadataClient = createApiClient({ baseUrl: 'http://localhost:3000', transport: async () => success({ ...metadata(), sha256: 'wrong' }, 'invalid-meta-log') });
  const metadataBrowser = createHttpArtifactBrowser(metadataClient);
  await assert.rejects(metadataBrowser.select(first, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-meta-log');
  metadataBrowser.dispose();
  const entriesClient = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input) => requestUrl(input).pathname.endsWith('/entries')
    ? success({ total: 1, entries: [{ name: 'missing-types' }], next_offset: null }, 'invalid-entries-log') : success(metadata(), 'metadata-log') });
  const entriesBrowser = createHttpArtifactBrowser(entriesClient);
  await entriesBrowser.select(first, signal());
  await assert.rejects(entriesBrowser.page({}, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-entries-log');
  entriesBrowser.dispose();
});

test('上传保留原始Blob、文件名、摘要和日志，响应元数据不一致时拒绝', async () => {
  const bytes = new Uint8Array([0, 255, 10, 13]);
  const content = new Blob([bytes], { type: 'application/octet-stream' });
  const seen: { filename: string; content: Blob; signal: AbortSignal }[] = [];
  const browser = createArtifactBrowser(gateway({ upload: async (filename, value, requestSignal) => {
    seen.push({ filename, content: value, signal: requestSignal });
    return { data: metadata({ filename, size: value.size, sha256: 'b'.repeat(64) }), logId: 'upload-log' };
  } }));
  const result = await browser.upload('原始.apk', content, signal());
  assert.equal(result.data.filename, '原始.apk');
  assert.equal(result.data.sha256, 'b'.repeat(64));
  assert.equal(result.logId, 'upload-log');
  assert.equal(browser.snapshot().uploadLogId, 'upload-log');
  assert.equal(seen[0]?.filename, '原始.apk');
  assert.equal(seen[0]?.content, content);
  assert.deepEqual(new Uint8Array(await seen[0]?.content.arrayBuffer() ?? []), bytes);
  assert.equal(seen[0]?.signal.aborted, false);
  browser.dispose();

  const invalid = createArtifactBrowser(gateway({ upload: async (filename, value) => ({ data: metadata({ filename, size: value.size + 1 }), logId: 'bad-upload-log' }) }));
  await assert.rejects(invalid.upload('原始.apk', content, signal()), (error: unknown) => error instanceof ApiError && error.code === 'invalid_artifact_upload' && error.logId === 'bad-upload-log');
  assert.equal(invalid.snapshot().uploadLogId, 'bad-upload-log');
  invalid.dispose();
});

test('下载保留原始字节和响应日志，缺少公共下载端口时不伪造请求', async () => {
  const bytes = new Uint8Array([0, 255, 10, 13]);
  const content = new Blob([bytes], { type: 'application/json' });
  const browser = createArtifactBrowser(gateway({ download: async (id, requestSignal) => {
    assert.equal(id, first);
    assert.equal(requestSignal.aborted, false);
    return { data: content, logId: 'download-log' };
  } }));
  const result = await browser.download(first.toUpperCase(), signal());
  assert.equal(result.data, content);
  assert.deepEqual(new Uint8Array(await result.data.arrayBuffer()), bytes);
  assert.equal(result.logId, 'download-log');
  assert.equal(browser.snapshot().downloadLogId, 'download-log');
  browser.dispose();

  const unavailable = createArtifactBrowser(gateway());
  assert.throws(() => unavailable.download(first, signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_download_unavailable');
  assert.throws(() => unavailable.upload('原始.apk', content, signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_upload_unavailable');
  assert.equal(unavailable.snapshot().loading, null);
  unavailable.dispose();
});

test('上传和下载取消或换代后，忽略信号的晚到成功不能写回日志', async () => {
  const uploadEntered = deferred<void>();
  const uploadBlocked = deferred<ApiResult<ArtifactMetadata>>();
  const browser = createArtifactBrowser(gateway({ upload: async () => { uploadEntered.resolve(); return uploadBlocked.promise; } }));
  const uploadWaiting = browser.upload('原始.apk', new Blob([new Uint8Array([1])]), signal());
  const uploadRejected = assert.rejects(uploadWaiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await uploadEntered.promise;
  browser.clear();
  await uploadRejected;
  uploadBlocked.resolve({ data: metadata({ filename: '原始.apk', size: 1 }), logId: 'late-upload-log' });
  assert.equal(browser.snapshot().uploadLogId, null);

  const firstEntered = deferred<void>();
  const firstBlocked = deferred<ApiResult<Blob>>();
  let downloadCalls = 0;
  const downloader = createArtifactBrowser(gateway({ download: async () => {
    downloadCalls++;
    if (downloadCalls === 1) { firstEntered.resolve(); return firstBlocked.promise; }
    return { data: new Blob([new Uint8Array([8])]), logId: 'second-download-log' };
  } }));
  const firstWaiting = downloader.download(first, signal());
  const firstRejected = assert.rejects(firstWaiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await firstEntered.promise;
  const second = downloader.download(first, signal());
  await second;
  await firstRejected;
  firstBlocked.resolve({ data: new Blob([new Uint8Array([9])]), logId: 'late-download-log' });
  assert.equal(downloader.snapshot().downloadLogId, 'second-download-log');
  browser.dispose();
  downloader.dispose();
});

test('HTTP工厂上传使用生成端点，下载保留内容响应原字节和日志头', async () => {
  const bytes = new Uint8Array([0, 255, 10]);
  const urls: { path: string; method: string }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input, init) => {
    const url = requestUrl(input);
    urls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET' });
    if (url.pathname.endsWith('/content')) return new Response(bytes, { status: 200, headers: { 'x-deviceforge-log-id': 'http-download-log' } });
    return success(metadata({ filename: '原始.apk', size: bytes.byteLength }), 'http-upload-log', 201);
  } });
  const browser = createHttpArtifactBrowser(client);
  const uploaded = await browser.upload('原始.apk', new Blob([bytes]), signal());
  const downloaded = await browser.download(first, signal());
  assert.equal(uploaded.logId, 'http-upload-log');
  assert.equal(downloaded.logId, 'http-download-log');
  assert.deepEqual(new Uint8Array(await downloaded.data.arrayBuffer()), bytes);
  assert.deepEqual(urls, [
    { path: '/api/v2/artifacts?filename=%E5%8E%9F%E5%A7%8B.apk', method: 'POST' },
    { path: `/api/v2/artifacts/${first}/content`, method: 'GET' },
  ]);
  browser.dispose();
});
