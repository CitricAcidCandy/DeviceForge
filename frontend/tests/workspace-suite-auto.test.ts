import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { WorkspaceLayoutNode } from '../src/plugin-sdk/index.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deviceforge/plugin-sdk') return { url: new URL('../src/plugin-sdk/index.ts', import.meta.url).href, shortCircuit: true };
  if (specifier === '@deviceforge/plugin-sdk/json') return { url: new URL('../src/plugin-sdk/json.ts', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { default: createSuite } = await import('../../examples/workspace-suite/browser/index.ts');
const { default: createDevices } = await import('../plugins/devices/src/index.ts');
const { default: createFiles, FILES_WORKSPACE_ID } = await import('../plugins/files/src/index.ts');
function leaves(node: WorkspaceLayoutNode | null): readonly string[] {
  if (!node) return [];
  if (node.kind === 'view') return [node.instanceId];
  if (node.kind === 'tabs') return node.items.flatMap((item) => leaves(item.node));
  return node.children?.flatMap(leaves) ?? [];
}

test('独立配套示例加载即跨设备文件页贡献，晚到页面和多次恢复不重复，卸载恢复原布局', async () => {
  let network = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { network++; throw new Error('自动界面组合不执行业务请求'); } });
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
    assert.equal(network, 0);
  } finally { await runtime.dispose(); }
});
