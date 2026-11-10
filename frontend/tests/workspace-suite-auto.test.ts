import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { WorkspaceLayoutNode } from '../src/plugin-sdk/index.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
const installedPackages = createRequire(new URL('../package.json', import.meta.url));
// 独立示例位于前端目录之外；夹具仅共享前端已安装的公开包，不映射宿主SDK兼容源码。
const sdkPackages = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deviceforge/plugin-sdk' || specifier.startsWith('@deviceforge/plugin-sdk/'))
    return { url: pathToFileURL(installedPackages.resolve(specifier)).href, shortCircuit: true };
  return next(specifier, context);
} });
const [{ default: createSuite }, { default: createDevices }, { default: createFiles, FILES_WORKSPACE_ID }] =
  await Promise.all([
    import('../../examples/workspace-suite/browser/index.ts'),
    import('../plugins/devices/src/index.ts'),
    import('../plugins/files/src/index.ts'),
  ]).finally(() => sdkPackages.deregister());
function leaves(node: WorkspaceLayoutNode | null): readonly string[] {
  if (!node) return [];
  if (node.kind === 'view') return [node.instanceId];
  if (node.kind === 'tabs') return node.items.flatMap((item) => leaves(item.node));
  return node.children?.flatMap(leaves) ?? [];
}

test('独立配套示例加载即跨设备文件页贡献，晚到页面和多次恢复不重复，卸载恢复原布局', async () => {
  let network = 0;
  let providerReads = 0;
  let deviceReads = 0;
  const unexpectedReads: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async (request, options) => {
      // 运行时首次只读提供者目录使用内存回执；组合插件的其他请求仍全部拒绝。
      const path = String(request);
      if (options?.method === 'GET' && (path === 'http://localhost:7031/api/v2/device-providers' ||
          path === 'http://localhost:7031/api/v2/devices')) {
        if (path.endsWith('/device-providers')) providerReads++;
        else deviceReads++;
        return new Response('{"data":[],"log_id":"provider-catalog-fixture"}', {
          headers: { 'content-type': 'application/json' },
        });
      }
      network++;
      const failure = new Error(`自动界面组合不执行业务请求：${String(request)}`);
      unexpectedReads.push(failure.stack ?? failure.message);
      throw failure;
    } });
  const ui = runtime.host.ui, points = runtime.host.extensions?.points;
  assert.ok(ui && points);
  const plugins = [
    createSuite({ id: 'workspace_suite.browser', version: '1', apiVersion: 2 }),
    createDevices({ id: 'deviceforge_devices', version: '1', apiVersion: 2 }),
    createFiles({ id: 'deviceforge_files', version: '1', apiVersion: 2 }),
  ];
  for (const plugin of plugins) runtime.bundledPlugins.register({ id: plugin.id, plugin, trusted: true });
  const filePoint = { id: 'deviceforge_files.tools', version: '1' };
  try {
    await runtime.webPlugins.load('workspace_suite.browser');
    assert.equal(points.list(filePoint)[0]?.state, 'waiting');
    await runtime.webPlugins.load('deviceforge_devices');
    await runtime.webPlugins.load('deviceforge_files');
    const fileEntry = points.list(filePoint)[0];
    assert.equal(fileEntry?.state, 'active');
    assert.equal(fileEntry?.provider.pluginId, 'workspace_suite.browser');
    const fileLayout = ui.readLayout(FILES_WORKSPACE_ID); assert.ok(fileLayout);
    assert.equal(leaves(fileLayout.root).length, 2, '无需调用attach或用户添加功能');
    const tools = ui.snapshot().instances.filter((instance) => instance.workspaceId === FILES_WORKSPACE_ID &&
      instance.provider?.pluginId === 'workspace_suite.browser');
    assert.equal(tools.length, 1); assert.equal(tools[0]?.state, 'ready');
    const deviceTools = ui.snapshot().instances.filter((instance) => instance.workspaceId === 'deviceforge_devices.workspace' &&
      instance.provider?.pluginId === 'workspace_suite.browser');
    assert.equal(deviceTools.length, 1);
    for (let index = 0; index < 3; index++) {
      ui.setVisible('deviceforge_files.browser.main', index % 2 === 0);
    }
    assert.equal(ui.snapshot().instances.filter((instance) => instance.workspaceId === FILES_WORKSPACE_ID &&
      instance.provider?.pluginId === 'workspace_suite.browser').length, 1);
    await runtime.webPlugins.unload('workspace_suite.browser');
    assert.deepEqual(ui.readLayout(FILES_WORKSPACE_ID)?.root, { kind: 'view', instanceId: 'deviceforge_files.browser.main' });
    assert.deepEqual(ui.readLayout('deviceforge_devices.workspace')?.root, { kind: 'view', instanceId: 'deviceforge_devices.workbench.main' });
    assert.equal(ui.snapshot().instances.some((instance) => tools.some((tool) => tool.instanceId === instance.instanceId)), false);
    await runtime.webPlugins.load('workspace_suite.browser');
    assert.equal(leaves(ui.readLayout(FILES_WORKSPACE_ID)?.root ?? null).length, 2);
    assert.equal(ui.snapshot().instances.some((instance) => tools.some((tool) => tool.instanceId === instance.instanceId)), false);
    await runtime.webPlugins.unload('deviceforge_files');
    await runtime.webPlugins.load('deviceforge_files');
    assert.equal(leaves(ui.readLayout(FILES_WORKSPACE_ID)?.root ?? null).length, 2);
    assert.equal(ui.snapshot().instances.filter((instance) => instance.workspaceId === FILES_WORKSPACE_ID &&
      instance.provider?.pluginId === 'workspace_suite.browser').length, 1);
    await runtime.webPlugins.unload('deviceforge_files');
    await runtime.webPlugins.unload('workspace_suite.browser');
    await runtime.webPlugins.load('deviceforge_files');
    assert.deepEqual(ui.readLayout(FILES_WORKSPACE_ID)?.root, { kind: 'view', instanceId: 'deviceforge_files.browser.main' });
    assert.equal(ui.snapshot().instances.some((instance) => instance.workspaceId === FILES_WORKSPACE_ID &&
      instance.provider?.pluginId === 'workspace_suite.browser'), false);
    assert.equal(network, 0, unexpectedReads.join('\n'));
    assert.equal(providerReads, 1, '仅运行时初始目录读取，不因界面组合启停重复联网');
    assert.equal(deviceReads, 1, '仅运行时初始设备目录读取，不触发发现、连接或选择设备');
  } finally { await runtime.dispose(); }
});
