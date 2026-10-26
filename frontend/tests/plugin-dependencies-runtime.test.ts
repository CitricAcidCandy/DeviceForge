import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createProductServices } from '../src/app/product/services.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { DependencyTarget } from '../src/features/plugin-dependencies/index.ts';
import { dependenciesView, dependency } from './plugin-dependencies-fixtures.ts';
import { deferred, failure, installedPackage, requestUrl, signal, success } from './fixtures.ts';

test('独立浏览器用例先读依赖再导入，空声明、可选缺失及 canonical release 就绪均直接通行', async () => {
  const targets: readonly DependencyTarget[] = [{ kind: 'browser', id: 'example' }, { kind: 'release', id: 'owner' }];
  for (const target of targets) {
    for (const dependencies of [[], [dependency({ required: false })]]) {
      const requests: string[] = [];
      let imports = 0;
      const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
        transport: async (input, init) => {
          const path = requestUrl(input).pathname;
          requests.push(path);
          assert.equal(init?.method, 'GET');
          if (path === '/api/v2/plugin-dependencies/browser/example')
            return success(dependenciesView({ target, dependencies, ready: true }), 'dependency-read-log');
          assert.equal(path, '/api/v2/plugin-packages/browser');
          return success([installedPackage()]);
        },
        esmImporter: async () => {
          ++imports;
          assert.deepEqual(requests, ['/api/v2/plugin-packages/browser', '/api/v2/plugin-dependencies/browser/example']);
          return { default: { id: 'example', version: '1.0', apiVersion: 2, panels: [] } };
        },
      });
      try {
        assert.equal((await runtime.pluginPackages.enable('browser', 'example', signal())).data.state, 'loaded');
        assert.equal(imports, 1);
      } finally { await runtime.dispose(); }
    }
  }
});

test('独立浏览器不能绕过必需依赖，canonical 未就绪同样拒绝并保留真实日志；补救后可重试', async () => {
  const kinds: readonly DependencyTarget['kind'][] = ['browser', 'release'];
  for (const kind of kinds) {
    let ready = false, imports = 0;
    const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
      transport: async (input) => requestUrl(input).pathname === '/api/v2/plugin-dependencies/browser/example'
        ? success(dependenciesView({ target: { kind, id: kind === 'release' ? 'owner' : 'example' }, ready,
          dependencies: [dependency({ status: ready ? 'ready' : 'missing' })] }), 'not-ready-log')
        : success([installedPackage()]),
      esmImporter: async () => {
        ++imports;
        return { default: { id: 'example', version: '1.0', apiVersion: 2, panels: [] } };
      },
    });
    try {
      await assert.rejects(runtime.pluginPackages.enable('browser', 'example', signal()),
        (error: unknown) => error instanceof ApiError && error.code === 'dependencies_required' && error.logId === 'not-ready-log');
      assert.equal(imports, 0);
      assert.deepEqual(runtime.webPlugins.snapshot(), []);
      ready = true;
      await runtime.pluginPackages.enable('browser', 'example', signal());
      assert.equal(imports, 1);
    } finally { await runtime.dispose(); }
  }
});

test('依赖读取失败或串目标不能降级导入；取消忽略信号的读取后迟到就绪也不执行代码', async () => {
  const delayed = deferred<Response>();
  const started = deferred<void>();
  let imports = 0;
  let response: () => Promise<Response> = async () => failure('dependency_unavailable', 503);
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input) => {
      if (requestUrl(input).pathname !== '/api/v2/plugin-dependencies/browser/example') return success([installedPackage()]);
      return response();
    },
    esmImporter: async () => { ++imports; throw new Error('依赖未确认时不应导入'); },
  });
  try {
    await assert.rejects(runtime.pluginPackages.enable('browser', 'example', signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'dependency_unavailable');
    response = async () => success(dependenciesView({ target: { kind: 'browser', id: 'other' }, dependencies: [], ready: true }));
    await assert.rejects(runtime.pluginPackages.enable('browser', 'example', signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'dependency_target_mismatch');
    response = async () => { started.resolve(); return delayed.promise; };
    const cancellation = new AbortController();
    const pending = runtime.pluginPackages.enable('browser', 'example', cancellation.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    await started.promise;
    cancellation.abort();
    await rejected;
    delayed.resolve(success(dependenciesView({ target: { kind: 'browser', id: 'example' }, dependencies: [], ready: true })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(imports, 0);
    assert.deepEqual(runtime.webPlugins.snapshot(), []);
  } finally { await runtime.dispose(); }
});

test('产品默认启用走同一浏览器依赖门禁，不通过 app defaults 绕过；重试重新读取后启用', async () => {
  let ready = false, imports = 0, reads = 0;
  const services = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      if (path === '/api/v2/plugin-dependencies/browser/example') {
        ++reads;
        return success(dependenciesView({ target: { kind: 'release', id: 'owner' }, ready,
          dependencies: [dependency({ status: ready ? 'ready' : 'missing' })] }), 'defaults-dependency-log');
      }
      return success(path === '/api/v2/plugin-packages/browser' ? [installedPackage()] : []);
    },
    esmImporter: async () => {
      ++imports;
      return { default: { id: 'example', version: '1.0', apiVersion: 2, panels: [] } };
    },
  });
  try {
    const blocked = await services.pluginDefaults.start(signal());
    assert.equal(blocked.results.find((item) => item.id === 'example')?.status, 'failed');
    assert.equal(blocked.results.find((item) => item.id === 'example')?.logId, 'defaults-dependency-log');
    assert.equal(imports, 0);
    ready = true;
    const retried = await services.pluginDefaults.retryFailures(signal());
    assert.equal(retried.results.find((item) => item.id === 'example')?.status, 'enabled');
    assert.equal(reads, 2);
    assert.equal(imports, 1);
  } finally { await services.dispose(); }
});
