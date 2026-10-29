import assert from 'node:assert/strict';
import test from 'node:test';
import createFilesPlugin, {
  FILES_INSTANCE_ID, FILES_WORKSPACE_ID,
} from '../plugins/files/src/index.ts';
import {
  createFileBrowser, FileError,
} from '../plugins/files/src/model/index.ts';
import { createPublicFileBrowser } from '../plugins/files/src/gateway.ts';
import type { Dispose, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { deferred } from './fixtures.ts';

const artifactId = '12345678-1234-1234-1234-123456789abc';
const raw = {
  id: artifactId, filename: '应用.zip', media_type: 'application/zip',
  size: 123, sha256: 'a'.repeat(64), created_at: 1,
};
const artifact = {
  id: artifactId, filename: '应用.zip', mediaType: 'application/zip',
  size: 123, sha256: 'a'.repeat(64), createdAt: 1,
};
function fixture(extra: Partial<HostContext> = {}) {
  const controller = new AbortController();
  const releases: Dispose[] = [];
  const host: HostContext = {
    apiVersion: 2, signal: controller.signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('本测试不派发业务'); },
    getJob: async () => { throw new Error('本测试不查询业务'); },
    cancelJob: async () => { throw new Error('本测试不取消任务'); },
    subscribeOperations: () => () => {},
    onDispose: (release) => { releases.push(release); return release; },
    ...extra,
  };
  return {
    host, controller,
    async dispose() { controller.abort(); for (const release of releases.reverse()) await release(); },
  };
}

test('官方文件插件只用公开工作区登记动态页面，激活不获取业务数据', async () => {
  const registry = createWorkspaceRegistry();
  const source = { pluginId: 'deviceforge_files', generation: 1, signal: new AbortController().signal };
  const ui = registry.access(source);
  const current = fixture({ ui });
  const plugin = createFilesPlugin({ id: source.pluginId, version: '0.1.0', apiVersion: 2 });
  assert.ok(plugin.activate);
  await plugin.activate(current.host);
  assert.equal(ui.catalog().pages[0]?.route, '/files');
  assert.equal(ui.catalog().views[0]?.id, 'deviceforge_files.browser');
  assert.equal(ui.snapshot().instances[0]?.instanceId, FILES_INSTANCE_ID);
  assert.equal(ui.snapshot().instances[0]?.state, 'ready');
  await current.dispose();
  registry.dispose();
});

test('关闭的默认文件视图在保存与重载后不自动重新打开', async () => {
  const source = { pluginId: 'deviceforge_files', generation: 1, signal: new AbortController().signal };
  const registry = createWorkspaceRegistry();
  const first = fixture({ ui: registry.access(source) });
  const plugin = createFilesPlugin({ id: source.pluginId, version: '0.1.0', apiVersion: 2 });
  assert.ok(plugin.activate);
  await plugin.activate(first.host);
  first.host.ui?.writeLayout(FILES_WORKSPACE_ID, { version: 1, root: null, floating: [], overlays: [] });
  first.host.ui?.close(FILES_INSTANCE_ID);
  const saved = registry.save();
  await first.dispose();
  registry.dispose();
  const restored = createWorkspaceRegistry();
  restored.restore(saved);
  const second = fixture({ ui: restored.access({ ...source, generation: 2 }) });
  await plugin.activate(second.host);
  assert.equal(second.host.ui?.snapshot().instances.length, 0);
  assert.equal(second.host.ui?.readLayout(FILES_WORKSPACE_ID)?.root, null);
  await second.dispose();
  restored.dispose();
});

test('公开文件网关复用当前transport和artifacts，保留元数据与ZIP分页日志', async () => {
  const requests: { path: string; method: string | undefined }[] = [];
  const current = fixture({
    transport: {
      async request(spec) {
        requests.push({ path: spec.path, method: spec.method });
        const data: JsonValue = spec.path.includes('/entries') ? {
          total: 1, next_offset: null,
          entries: [{ name: '配置.json', size: 8, compressed_size: 6, directory: false }],
        } : raw;
        return { data, logId: spec.method === 'DELETE' ? 'remove-log' : 'query-log' };
      },
      bytes: async () => { throw new Error('字节下载应走公开产物服务'); },
      stream: async () => { throw new Error('本功能不创建流'); },
    },
    artifacts: {
      upload: async () => ({ data: artifact, logId: 'upload-log' }),
      download: async () => ({ data: new Blob(['zip']), logId: 'download-log' }),
    },
  });
  const browser = createPublicFileBrowser(current.host);
  const selected = await browser.select(artifactId.toUpperCase(), current.host.signal);
  assert.deepEqual(selected.data, artifact);
  const page = await browser.page({ offset: 0, limit: 1 }, current.host.signal);
  assert.equal(page.data.entries[0]?.compressedSize, 6);
  assert.equal(page.logId, 'query-log');
  assert.equal((await browser.download(artifactId, current.host.signal)).logId, 'download-log');
  assert.equal((await browser.upload(artifact.filename, new Blob(['x'.repeat(123)]), current.host.signal)).logId, 'upload-log');
  await browser.remove(artifactId, current.host.signal);
  assert.equal(browser.snapshot().selection, null);
  assert.deepEqual(requests, [
    { path: `/api/v2/artifacts/${artifactId}`, method: 'GET' },
    { path: `/api/v2/artifacts/${artifactId}/entries?offset=0&limit=1`, method: 'GET' },
    { path: `/api/v2/artifacts/${artifactId}`, method: 'DELETE' },
  ]);
  await current.dispose();
});

test('文件模型撤销会结束忽略信号的网关等待，晚到结果不能回写新状态', async () => {
  const blocked = deferred<{ data: typeof artifact; logId: string }>();
  const browser = createFileBrowser({
    metadata: () => blocked.promise,
    entries: async () => { throw new Error('未选择文件'); },
    remove: async () => { throw new Error('本测试不删除'); },
  });
  const pending = browser.select(artifactId, new AbortController().signal);
  const cancelled = assert.rejects(pending, (error: unknown) =>
    error instanceof FileError && error.kind === 'cancelled');
  browser.dispose();
  await cancelled;
  blocked.resolve({ data: artifact, logId: 'late-log' });
  await Promise.resolve();
  assert.equal(browser.snapshot().metadata, null);
});

test('公开文件响应身份不匹配时拒绝结果并保留原日志，不发送自动重试', async () => {
  let requests = 0;
  const browser = createFileBrowser({
    metadata: async () => {
      requests++;
      return { data: { ...artifact, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, logId: 'identity-log' };
    },
    entries: async () => { throw new Error('未选择文件'); },
    remove: async () => { throw new Error('不重放变更'); },
  });
  await assert.rejects(browser.select(artifactId, new AbortController().signal),
    (error: unknown) => error instanceof FileError &&
      error.code === 'invalid_artifact_metadata' && error.logId === 'identity-log');
  assert.equal(requests, 1);
  assert.equal(browser.snapshot().metadata, null);
  browser.dispose();
});
