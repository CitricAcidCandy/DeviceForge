import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred, failure, installedPackage, plugin, requestUrl, signal, success } from './fixtures.ts';

test('两类包经 app 用例上传原字节与必填 format，仅更新部署目录，不隐式启用', async () => {
  const content = new Blob(['压缩包原始字节']); const requests: string[] = [];
  let imports = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    esmImporter: async () => { ++imports; throw new Error('上传不应执行代码'); },
    transport: async (input, init) => {
      const url = requestUrl(input); requests.push(`${init?.method} ${url.pathname}${url.search}`);
      const kind = url.pathname.endsWith('/server') ? 'server' : 'browser';
      assert.equal(url.pathname, `/api/v2/plugin-packages/${kind}`);
      if (init?.method === 'POST') {
        assert.equal(init.body, content);
        assert.equal(url.search, kind === 'server' ? '?format=tgz' : '?format=zip');
        assert.equal(new Headers(init.headers).get('content-type'), kind === 'server' ? 'application/gzip' : 'application/zip');
        return success(installedPackage(kind), 'install-log', 201);
      }
      assert.equal(init?.method, 'GET'); assert.equal(url.search, '');
      return success([installedPackage(kind)], 'directory-log');
    },
  });
  assert.equal((await runtime.pluginPackages.upload('server', content, 'application/gzip', signal())).logId, 'install-log');
  await runtime.pluginPackages.upload('browser', content, 'application/zip', signal());
  assert.equal(runtime.pluginPackages.snapshot('browser').result?.data[0]?.entry_path, 'dist/index.js');
  assert.equal(runtime.pluginPackages.snapshot('server').result?.logId, 'directory-log');
  assert.equal(requests.length, 4); assert.equal(imports, 0); assert.deepEqual(runtime.webPlugins.snapshot(), []);
  await runtime.dispose();
});

test('上传取消后以独立信号重查已生效部署，不重放且晚到传输错误不覆盖目录', async () => {
  for (const kind of ['server', 'browser']) {
    const started = deferred<void>(); const response = deferred<Response>();
    const cancellation = new AbortController(); let posts = 0; let queries = 0;
    const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (_url, init) => {
      if (init?.method === 'POST') { ++posts; started.resolve(); return response.promise; }
      ++queries; assert.equal(init?.signal?.aborted, false);
      return success([installedPackage(kind === 'server' ? 'server' : 'browser')], 'reconcile-log');
    } });
    const packageKind = kind === 'server' ? 'server' : 'browser';
    const waiting = runtime.pluginPackages.upload(packageKind, new Blob(['包']), 'application/gzip', cancellation.signal);
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    await started.promise; cancellation.abort(); await rejected;
    assert.equal(posts, 1); assert.equal(queries, 1);
    assert.equal(runtime.pluginPackages.snapshot(packageKind).result?.logId, 'reconcile-log');
    response.reject(new Error('晚到安装响应失败'));
    await runtime.dispose();
  }
});

test('浏览器删除失败前已停本实例并撤销源，安装目录仍在时可重新启用为新代', async () => {
  const urls: string[] = []; let stopped = 0; let deletions = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    esmImporter: async (url) => {
      urls.push(url);
      return { default: { id: 'example', version: '1.0', apiVersion: 2, panels: [], activate: async (host: HostContext) => {
        host.onDispose(() => { ++stopped; });
      } } };
    },
    transport: async (_url, init) => {
      if (init?.method === 'DELETE') {
        ++deletions; assert.equal(stopped, 1); assert.deepEqual(runtime.webPlugins.snapshot(), []);
        return failure('package_delete_failed', 500);
      }
      return success([installedPackage()]);
    },
  });
  const first = await runtime.pluginPackages.enable('browser', 'example', signal());
  await assert.rejects(runtime.pluginPackages.remove('browser', 'example', signal()), (error: unknown) => error instanceof ApiError && error.code === 'package_delete_failed');
  await assert.rejects(runtime.webPlugins.load('example'), /预注册/);
  const next = await runtime.pluginPackages.enable('browser', 'example', signal());
  assert.notEqual(first.data.generation, next.data.generation); assert.notEqual(urls[0], urls[1]);
  assert.notEqual(new URL('./dependency.js', urls[0]).href, new URL('./dependency.js', urls[1]).href);
  assert.equal(runtime.pluginPackages.snapshot('browser').result?.data[0]?.id, 'example');
  assert.equal(deletions, 1); await runtime.pluginPackages.disable('browser', 'example', signal());
  assert.equal(stopped, 2); await runtime.dispose();
});

test('缺少 crypto.randomUUID 时在线包仍可启停重载，不复用运行路径或相对依赖', async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const runtimes: ReturnType<typeof createFrontendRuntime>[] = [];
  const contexts: HostContext[] = []; const urls: string[] = []; let stopped = 0;
  try {
    // 仅模拟普通 LAN HTTP 缺少安全上下文方法，不作为真实浏览器验收证据。
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    const createRuntime = () => {
      const runtime = createFrontendRuntime({ baseUrl: 'http://192.168.50.5:7031', panelTarget: () => null,
        esmImporter: async (url) => {
          urls.push(url);
          return { default: { id: 'example', version: '1.0', apiVersion: 2, panels: [], activate: async (host: HostContext) => {
            contexts.push(host); host.onDispose(() => { ++stopped; });
          } } };
        },
        transport: async () => success([installedPackage()]),
      });
      runtimes.push(runtime); return runtime;
    };
    const runtime = createRuntime();
    const first = await runtime.pluginPackages.enable('browser', 'example', signal());
    const repeated = await runtime.pluginPackages.enable('browser', 'example', signal());
    assert.equal(repeated.data.generation, first.data.generation);
    assert.equal(urls.length, 1); assert.equal(contexts.length, 1);
    const oldContext = contexts[0]; assert.ok(oldContext); assert.equal(oldContext.signal.aborted, false);
    await runtime.pluginPackages.disable('browser', 'example', signal());
    assert.equal(oldContext.signal.aborted, true); assert.equal(stopped, 1);
    assert.deepEqual(runtime.webPlugins.snapshot(), []);
    const next = await runtime.pluginPackages.enable('browser', 'example', signal());
    assert.notEqual(next.data.generation, first.data.generation);
    const newContext = contexts[1]; assert.ok(newContext); assert.equal(newContext.signal.aborted, false);
    // 同一模块内不同宿主实例也不得共享同 ID 包的运行路径。
    const other = createRuntime(); await other.pluginPackages.enable('browser', 'example', signal());
    assert.equal(urls.length, 3); assert.equal(contexts.length, 3);
    assert.equal(new Set(urls).size, 3);
    const dependencies = urls.map((url) => new URL('./dependency.js', url).href);
    assert.equal(new Set(dependencies).size, 3);
    for (const url of urls) {
      assert.equal(new URL(url).origin, 'http://192.168.50.5:7031');
      assert.match(new URL(url).pathname, /^\/api\/v2\/browser-plugins\/example\/runs\/[A-Za-z0-9_-]+\/assets\/dist\/index\.js$/);
    }
    for (const url of dependencies) {
      assert.match(new URL(url).pathname, /^\/api\/v2\/browser-plugins\/example\/runs\/[A-Za-z0-9_-]+\/assets\/dist\/dependency\.js$/);
    }
  } finally {
    try {
      const releases = await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()));
      for (const release of releases) if (release.status === 'rejected') throw release.reason;
    } finally {
      if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  }
  assert.equal(stopped, 3); assert.ok(contexts.every((context) => context.signal.aborted));
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'crypto'), originalCrypto);
});

test('浏览器资源释放失败阻止部署删除，报告错误并允许从保留部署重新启用', async () => {
  let releases = 0; let deletions = 0; let imports = 0;
  const contexts: HostContext[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    esmImporter: async () => {
      ++imports;
      return { default: { id: 'example', version: '1.0', apiVersion: 2, panels: [], activate: async (host: HostContext) => {
        contexts.push(host); host.onDispose(() => { if (++releases === 1) throw new Error('扩展清理失败'); });
      } } };
    },
    transport: async (_url, init) => { if (init?.method === 'DELETE') ++deletions; return success([installedPackage()]); },
  });
  await runtime.pluginPackages.enable('browser', 'example', signal());
  await assert.rejects(runtime.pluginPackages.remove('browser', 'example', signal()), (error: unknown) => error instanceof AggregateError);
  assert.equal(contexts[0]?.signal.aborted, true); assert.equal(deletions, 0);
  assert.deepEqual(runtime.webPlugins.snapshot(), []);
  assert.equal(runtime.pluginPackages.snapshot('browser').result?.data[0]?.id, 'example');
  await runtime.pluginPackages.enable('browser', 'example', signal());
  assert.equal(imports, 2); assert.equal(contexts[1]?.signal.aborted, false);
  await runtime.dispose(); assert.equal(releases, 2);
});

test('浏览器删除等待取消仍重查服务端已删除目录，本实例保持停用且不重复 DELETE', async () => {
  const started = deferred<void>(); const response = deferred<Response>();
  let installed = true; let deletions = 0; let stopped = false;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    esmImporter: async () => ({ default: { id: 'example', version: '1.0', apiVersion: 2, panels: [], activate: async (host: HostContext) => {
      host.onDispose(() => { stopped = true; });
    } } }),
    transport: async (_url, init) => {
      if (init?.method === 'DELETE') { ++deletions; assert.equal(stopped, true); installed = false; started.resolve(); return response.promise; }
      assert.equal(init?.signal?.aborted, false); return success(installed ? [installedPackage()] : []);
    },
  });
  await runtime.pluginPackages.enable('browser', 'example', signal());
  const cancellation = new AbortController();
  const waiting = runtime.pluginPackages.remove('browser', 'example', cancellation.signal);
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await started.promise; cancellation.abort(); await rejected;
  assert.equal(deletions, 1); assert.deepEqual(runtime.pluginPackages.snapshot('browser').result?.data, []);
  assert.deepEqual(runtime.webPlugins.snapshot(), []);
  response.resolve(success(installedPackage()));
  await assert.rejects(runtime.pluginPackages.enable('browser', 'example', signal()), (error: unknown) => error instanceof ApiError && error.code === 'package_not_installed');
  await runtime.dispose();
});

test('服务器包用例按实际运行目录启停，删除先卸载且卸载失败不发送 DELETE', async () => {
  let running = false; let deployed = true; let rejectUnload = false;
  const calls: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input, init) => {
    const path = requestUrl(input).pathname; calls.push(`${init?.method} ${path}`);
    if (path.endsWith('/load')) { running = true; return success(plugin(), 'load-log'); }
    if (path.endsWith('/unload')) {
      if (rejectUnload) return failure('cleanup_failed');
      running = false; return success(plugin({ state: 'unloaded' }));
    }
    if (path === '/api/v2/plugins') return success(running ? [plugin({ cleanup_failed: rejectUnload, state: rejectUnload ? 'draining' : 'loaded' })] : []);
    if (path === '/api/v2/operations') return success([]);
    if (path === '/api/v2/device-providers' || path === '/api/v2/devices') return success([]);
    if (init?.method === 'DELETE') { assert.equal(running, false); deployed = false; return success(installedPackage('server')); }
    return success(deployed ? [installedPackage('server')] : []);
  } });
  assert.equal((await runtime.pluginPackages.enable('server', 'example', signal())).logId, 'load-log');
  await runtime.pluginPackages.disable('server', 'example', signal()); assert.equal(running, false);
  await runtime.pluginPackages.enable('server', 'example', signal()); rejectUnload = true;
  await assert.rejects(runtime.pluginPackages.remove('server', 'example', signal()), (error: unknown) => error instanceof ApiError && error.code === 'cleanup_failed');
  assert.equal(calls.some((call) => call.startsWith('DELETE')), false);
  assert.equal(runtime.serverPlugins.snapshot().result?.data[0]?.cleanup_failed, true);
  assert.equal(runtime.pluginPackages.snapshot('server').result?.data[0]?.id, 'example');
  rejectUnload = false; await runtime.pluginPackages.remove('server', 'example', signal());
  const deleteIndex = calls.indexOf('DELETE /api/v2/plugin-packages/server/example');
  assert.ok(deleteIndex > calls.lastIndexOf('POST /api/v2/plugins/example/unload'));
  assert.deepEqual(runtime.pluginPackages.snapshot('server').result?.data, []); await runtime.dispose();
});
