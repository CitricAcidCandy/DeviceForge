import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { dom } from './dom-fixtures.ts';
import { success, job } from './fixtures.ts';

function themes(context: HostContext | undefined) {
  assert.ok(context);
  assert.ok(context.themes);
  return context.themes;
}
function cancelled(error: unknown): boolean {
  return error instanceof HostError && error.kind === 'cancelled';
}

test('面板与模块退出撤销主题子入口和订阅，兄弟和插件实例继续使用', async () => {
  const target = dom();
  const panelTarget = dom();
  const moduleTarget = dom();
  const instance = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    themeTarget: target,
    panelTarget: () => panelTarget,
    moduleTarget: () => moduleTarget,
    transport: async () => success(job()),
  });
  let root: HostContext | undefined;
  let panel: HostContext | undefined;
  let module: HostContext | undefined;
  let panelNotices = 0;
  let moduleNotices = 0;
  instance.webPlugins.register({
    id: 'scope',
    trusted: true,
    plugin: {
      id: 'scope',
      version: '1',
      apiVersion: 2,
      activate: async (context) => {
        root = context;
      },
      panels: [
        {
          id: 'scope.panel',
          title: '面板',
          mount: async (_target, context) => {
            panel = context;
            themes(context).subscribe(() => {
              panelNotices += 1;
            });
            return () => {};
          },
        },
      ],
      contributions: {
        themes: [{ id: 'scope.theme', title: '主题', variables: { '--scope': '1' } }],
        modules: [
          {
            id: 'scope.module',
            title: '模块',
            route: '/scope',
            mount: async (_target, context) => {
              module = context;
              themes(context).subscribe(() => {
                moduleNotices += 1;
              });
              return () => {};
            },
          },
        ],
      },
    },
  });
  await instance.webPlugins.load('scope');
  await instance.webPlugins.mount('scope', 'scope.panel');
  await instance.extensions.mountModule('scope.module');
  themes(panel).select('scope.theme');
  assert.equal(target.style.getPropertyValue('--scope'), '1');
  const panelBefore = panelNotices;
  await instance.webPlugins.unmount('scope', 'scope.panel');
  assert.throws(() => themes(panel).snapshot(), cancelled);
  assert.throws(() => themes(panel).select(null), cancelled);
  assert.throws(() => themes(panel).subscribe(() => {}), cancelled);
  themes(module).select(null);
  assert.equal(panelNotices, panelBefore);
  assert.equal(target.style.getPropertyValue('--scope'), '');
  themes(root).select('scope.theme');
  const moduleBefore = moduleNotices;
  await instance.extensions.unmount('scope.module');
  assert.throws(() => themes(module).select(null), cancelled);
  themes(root).select(null);
  assert.equal(moduleNotices, moduleBefore);
  const oldRoot = root;
  const oldGeneration = instance.themes.snapshot().themes[0]?.generation;
  await instance.webPlugins.unload('scope');
  await instance.webPlugins.load('scope');
  assert.notEqual(instance.themes.snapshot().themes[0]?.generation, oldGeneration);
  assert.throws(() => themes(oldRoot).select('scope.theme'), cancelled);
  themes(root).select('scope.theme');
  await instance.dispose();
  assert.equal(target.style.getPropertyValue('--scope'), '');
});

test('订阅即时回调中关闭子作用域仍释放刚建立的主题订阅，旧宿主缺省字段保持省略', async () => {
  const target = dom();
  const instance = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    themeTarget: target,
    panelTarget: () => dom(),
    transport: async () => success(job()),
  });
  let panel: HostContext | undefined;
  let notices = 0;
  let unmounting: Promise<void> | undefined;
  instance.webPlugins.register({
    id: 'immediate',
    trusted: true,
    plugin: {
      id: 'immediate',
      version: '1',
      apiVersion: 2,
      panels: [
        {
          id: 'immediate.panel',
          title: '面板',
          mount: async (_target, context) => {
            panel = context;
            themes(context).subscribe(() => {
              notices += 1;
              unmounting = instance.webPlugins.unmount('immediate', 'immediate.panel');
            });
            return () => {};
          },
        },
      ],
      contributions: { themes: [{ id: 'immediate.theme', title: '主题' }] },
    },
  });
  await instance.webPlugins.load('immediate');
  await assert.rejects(instance.webPlugins.mount('immediate', 'immediate.panel'), cancelled);
  await unmounting;
  assert.equal(notices, 1);
  instance.themes.select('immediate.theme');
  assert.equal(notices, 1);
  assert.throws(() => themes(panel).snapshot(), cancelled);
  await instance.dispose();
});
