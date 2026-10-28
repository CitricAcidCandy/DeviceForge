import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebuggerReload } from '../src/app/debugger-reload.ts';
import { createApiClient } from '../src/services/api/index.ts';
import { installedPackage, signal, success } from './fixtures.ts';
import { release } from './plugin-installations-fixture.ts';

const unused = async (): Promise<never> => { throw new Error('不应调用另一个安装入口'); };
function fixture() {
  let generation = 1;
  const actions: string[] = [];
  const manager = {
    diagnosticSnapshot: () => generation ? [{ id: 'example-browser', generation, version: '1.0.0', state: 'loaded' as const, panels: [] }] : [],
    unload: async (id: string) => { actions.push(`unload:${id}`); generation = 0; },
    load: async (id: string) => { actions.push(`load:${id}`); generation = 2; return { id, generation, state: 'loaded' as const }; },
  };
  return { manager, actions, next: () => { generation = 2; } };
}

test('完整功能同版本新修订重载使用原整套协调器，不复用旧入口或另建安装任务', async () => {
  const host = fixture();
  const revision = 'b'.repeat(64);
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:7031', transport: async () => success([{
    ...release(true, '1.0.0', revision), installed_at: 1, requirements: [], tools: [],
    components: [{ id: 'example-browser', kind: 'browser', version: '1.0.0', revision, entry_path: 'dist/index.js', entry_url: null }],
  }]) });
  const reload = createDebuggerReload({ client, manager: () => host.manager,
    packages: () => ({ refresh: unused, enable: unused }), browser: () => ({ forget: unused }),
    forgetReleaseSource: () => { throw new Error('成套组件不得降成独立包'); },
    installations: () => ({ retryBrowser: async (id, expected) => {
      host.actions.push('retry-feature');
      assert.equal(id, 'example-release'); assert.equal(expected, revision);
      host.next(); return release(true, '1.0.0', revision);
    } }),
  });
  const result = await reload({ plugin_id: 'example-browser', generation: '1' }, signal());
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result));
  assert.equal(result.generation, '2'); assert.equal(result.revision, revision);
  assert.equal(result.scope, 'installed-feature-browser-components');
  assert.deepEqual(host.actions, ['unload:example-browser', 'retry-feature']);
});

test('独立包重载先读取实际目录并撤销原加载源，同版本也生成新运行代次', async () => {
  const host = fixture();
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:7031', transport: async () => success([]) });
  const reload = createDebuggerReload({ client, manager: () => host.manager,
    installations: () => ({ retryBrowser: unused }),
    packages: () => ({
      refresh: async () => { host.actions.push('refresh'); return { data: [installedPackage('browser', { id: 'example-browser' })], logId: null }; },
      enable: async (_kind, id) => { host.actions.push(`enable:${id}`); host.next(); return { data: { id, generation: 2, state: 'loaded' }, logId: null }; },
    }),
    browser: () => ({ forget: async id => { host.actions.push(`forget:${id}`); } }),
    forgetReleaseSource: id => { host.actions.push(`clear-source:${id}`); },
  });
  const result = await reload({ plugin_id: 'example-browser', generation: '1' }, signal());
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result));
  assert.equal(result.generation, '2');
  assert.deepEqual(host.actions, ['refresh', 'forget:example-browser', 'clear-source:example-browser', 'enable:example-browser']);
});

test('读取安装目录期间另一管理请求已换代时拒绝卸载新实例', async () => {
  const host = fixture();
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:7031', transport: async () => { host.next(); return success([]); } });
  const reload = createDebuggerReload({ client, manager: () => host.manager,
    packages: () => ({ refresh: unused, enable: unused }), browser: () => ({ forget: unused }),
    installations: () => ({ retryBrowser: unused }), forgetReleaseSource: () => {},
  });
  await assert.rejects(reload({ plugin_id: 'example-browser', generation: '1' }, signal()), /已换代/);
  assert.deepEqual(host.actions, []);
});
