import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { noBrowserDependencies } from './plugin-dependencies-fixtures.ts';
import { deferred, failure, installedPackage, requestUrl, signal, success } from './fixtures.ts';

test('浏览器更新先清理本实例，再以 PUT 原字节替换，核对期望版本且不删除旧部署', async () => {
  const content = new Blob(['新压缩包']);
  const requests: string[] = [];
  let version = '1.0';
  let stopped = 0;
  let imports = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    esmImporter: async () => {
      ++imports;
      return { default: { id: 'example', version, apiVersion: 2, panels: [], activate: async (host: HostContext) => {
        host.onDispose(() => { ++stopped; });
      } } };
    },
    transport: async (input, init) => {
      const url = requestUrl(input);
      requests.push(`${init?.method} ${url.pathname}`);
      if (url.pathname === '/api/v2/plugin-dependencies/browser/example') return success(noBrowserDependencies());
      if (init?.method === 'PUT') {
        assert.equal(stopped, 1);
        assert.deepEqual(runtime.webPlugins.snapshot(), []);
        assert.equal(url.pathname, '/api/v2/plugin-packages/browser/example');
        assert.equal(url.searchParams.get('format'), 'zip');
        assert.equal(url.searchParams.get('expected_version'), '2.0');
        assert.equal(init.body, content);
        assert.equal(new Headers(init.headers).get('content-type'), 'application/zip');
        version = '2.0';
        return success(installedPackage('browser', { version }), 'update-log');
      }
      assert.equal(init?.method, 'GET');
      return success([installedPackage('browser', { version })], 'directory-log');
    },
  });
  try {
    await runtime.pluginPackages.enable('browser', 'example', signal());
    const result = await runtime.pluginPackages.update('browser', 'example', content, 'application/zip', signal(), '2.0');
    assert.equal(result.logId, 'update-log');
    assert.equal(result.data.version, '2.0');
    assert.equal(runtime.pluginPackages.snapshot('browser').result?.data[0]?.version, '2.0');
    assert.equal(imports, 1);
    assert.equal(requests.filter((request) => request.startsWith('PUT')).length, 1);
    assert.equal(requests.some((request) => /^(DELETE|POST) /.test(request)), false);
    await runtime.pluginPackages.enable('browser', 'example', signal());
    assert.equal(imports, 2);
  } finally {
    await runtime.dispose();
  }
});

test('新包校验失败后重查原部署，旧版本仍可重新启用', async () => {
  let puts = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    esmImporter: async () => ({ default: { id: 'example', version: '1.0', apiVersion: 2, panels: [] } }),
    transport: async (input, init) => {
      if (requestUrl(input).pathname === '/api/v2/plugin-dependencies/browser/example') return success(noBrowserDependencies());
      if (init?.method === 'PUT') { ++puts; return failure('invalid_input', 400); }
      assert.equal(init?.method, 'GET');
      return success([installedPackage()], 'old-deployment');
    },
  });
  try {
    await runtime.pluginPackages.enable('browser', 'example', signal());
    await assert.rejects(runtime.pluginPackages.update('browser', 'example', new Blob(['错误包']), 'application/zip', signal(), '2.0'),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_input');
    assert.equal(puts, 1);
    assert.equal(runtime.pluginPackages.snapshot('browser').result?.data[0]?.version, '1.0');
    await runtime.pluginPackages.enable('browser', 'example', signal());
    assert.equal(runtime.webPlugins.snapshot()[0]?.id, 'example');
  } finally { await runtime.dispose(); }
});

test('更新取消后独立重查已生效版本，不自动重放 PUT', async () => {
  const started = deferred<void>();
  const response = deferred<Response>();
  const cancellation = new AbortController();
  let puts = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (_input, init) => {
      if (init?.method === 'PUT') { ++puts; started.resolve(); return response.promise; }
      assert.equal(init?.method, 'GET');
      assert.equal(init.signal?.aborted, false);
      return success([installedPackage('browser', { version: '2.0' })], 'reconciled');
    },
  });
  try {
    const pending = runtime.pluginPackages.update('browser', 'example', new Blob(['新包']), 'application/gzip', cancellation.signal, '2.0');
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    await started.promise;
    cancellation.abort();
    await rejected;
    assert.equal(puts, 1);
    assert.equal(runtime.pluginPackages.snapshot('browser').result?.data[0]?.version, '2.0');
    response.reject(new Error('晚到响应失败'));
  } finally { await runtime.dispose(); }
});

test('市场首次安装可要求真实包 ID 和版本，不影响旧上传调用', async () => {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const url = requestUrl(input);
      if (init?.method === 'POST') {
        assert.equal(url.searchParams.get('expected_id'), 'example');
        assert.equal(url.searchParams.get('expected_version'), '1.0');
        return success(installedPackage(), 'installed', 201);
      }
      return success([installedPackage()]);
    },
  });
  try { await runtime.pluginPackages.upload('browser', new Blob(['包']), 'application/zip', signal(), { id: 'example', version: '1.0' }); }
  finally { await runtime.dispose(); }
});
