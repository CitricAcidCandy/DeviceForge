import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

test('统一安装恢复经真实包控制器和管理器时，慢插件激活不阻挡后续界面提供者', async () => {
  const gate = deferred<void>();
  const revision = 'a'.repeat(64);
  const entries = ['slow-release', 'ready-release'].map((id) => ({
    id, name: id, description: '独立恢复夹具', version: '1.0.0', revision,
    enabled: true, status: 'enabled', installed_at: 1, tools: [], requirements: [],
    components: [{
      id: `${id}-browser`, kind: 'browser', version: '1.0.0', revision, entry_path: 'dist/index.js',
      entry_url: `/api/v2/plugin-installations/browser/${id}-browser/revisions/${revision}/assets/dist/index.js`,
    }],
  }));
  const activated: string[] = [], imported: string[] = [], requests: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    esmImporter: async (url) => {
      const entry = entries.find((candidate) => new URL(url).pathname.includes(`/browser/${candidate.id}-browser/`));
      assert.ok(entry, '管理器必须从安装包当前修订入口载入');
      const component = entry.components[0]; assert.ok(component);
      imported.push(component.id);
      return { default: { id: component.id, version: '1.0.0', apiVersion: 2, panels: [],
        activate: async (_context: HostContext) => {
          activated.push(component.id);
          if (entry.id === 'slow-release') await gate.promise;
        },
      } };
    },
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/v2/plugin-installations') return success(entries, 'restore-directory-log');
      throw new Error(`恢复浏览器不应提交额外请求：${path}`);
    },
  });
  const waiting = runtime.pluginInstallations.restore(signal());
  void waiting.catch(() => undefined);
  try {
    for (let index = 0; index < 20; index++) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      if (runtime.webPlugins.snapshot().some((value) => value.id === 'ready-release-browser' && value.state === 'loaded')) break;
    }
    assert.deepEqual(activated, ['slow-release-browser', 'ready-release-browser']);
    assert.equal(runtime.webPlugins.snapshot().find((value) => value.id === 'ready-release-browser')?.state, 'loaded');
    assert.equal(runtime.webPlugins.snapshot().find((value) => value.id === 'slow-release-browser')?.state, 'loading');
    assert.equal(runtime.pluginInstallations.clientSnapshot().find((value) => value.id === 'ready-release')?.phase, 'enabled');
    gate.resolve(); await waiting;
    assert.equal(runtime.webPlugins.snapshot().filter((value) => value.state === 'loaded').length, 2);
    assert.deepEqual(imported, activated, '每个入口只载入一次，不靠重复激活等待就绪');
    assert.deepEqual(requests, ['GET /api/v2/plugin-installations']);
  } finally { gate.resolve(); await waiting.catch(() => undefined); await runtime.dispose(); }
});
