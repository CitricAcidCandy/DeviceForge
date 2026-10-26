import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred, failure, installedPackage, plugin, requestUrl, signal, success } from './fixtures.ts';

test('历史 cleanup_failed 保留目录警告，但不阻断同实例的服务器管理及包显式调用', async () => {
  const calls: string[] = [];
  const first = deferred<Response>();
  const began = deferred<void>();
  let loads = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      calls.push(`${init?.method} ${path}`);
      if (path.endsWith('/plugins/example/load')) {
        if (++loads === 1) { began.resolve(); return first.promise; }
        return success(plugin({ cleanup_failed: true }), 'load-warning-log');
      }
      if (path.endsWith('/plugins/example/unload'))
        return success(plugin({ state: 'unloaded', cleanup_failed: true }), 'unload-warning-log');
      if (path.endsWith('/plugin-packages/server/example') && init?.method === 'DELETE')
        return success(installedPackage('server'));
      if (path.endsWith('/plugin-packages/server')) return success([installedPackage('server')]);
      if (path.endsWith('/plugins')) return success([plugin({ cleanup_failed: true })], 'warning-log');
      if (path.endsWith('/operations') || path.endsWith('/device-providers') || path.endsWith('/devices'))
        return success([]);
      throw new Error(`未预期请求：${path}`);
    },
  });
  try {
    await runtime.serverPlugins.refresh(signal());
    assert.equal(runtime.serverPlugins.snapshot().result?.data[0]?.cleanup_failed, true);
    const loading = runtime.serverPlugins.load('example', signal());
    const rejected = assert.rejects(loading, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'cleanup_failed');
      assert.equal(error.logId, 'log-error');
      return true;
    });
    const unloading = runtime.serverPlugins.unload('example', signal());
    await began.promise;
    assert.equal(calls.filter((entry) => entry.startsWith('POST')).length, 1);
    first.resolve(failure('cleanup_failed'));
    await rejected;
    await unloading;
    assert.equal(loads, 1, '管理失败不自动重放');
    assert.equal(runtime.serverPlugins.snapshot().result?.data[0]?.cleanup_failed, true);
    const enabled = await runtime.pluginPackages.enable('server', 'example', signal());
    assert.equal(enabled.logId, 'load-warning-log');
    await runtime.pluginPackages.disable('server', 'example', signal());
    await runtime.pluginPackages.remove('server', 'example', signal());
    assert.equal(loads, 2);
    assert.equal(calls.filter((entry) => entry.endsWith('/plugins/example/unload')).length, 3);
    assert.equal(calls.filter((entry) => entry === 'DELETE /api/v2/plugin-packages/server/example').length, 1);
    assert.equal(runtime.serverPlugins.snapshot().result?.data[0]?.cleanup_failed, true);
    assert.equal(runtime.serverPlugins.snapshot().result?.logId, 'warning-log');
  } finally {
    first.resolve(failure('cleanup_failed'));
    await runtime.dispose();
  }
});
