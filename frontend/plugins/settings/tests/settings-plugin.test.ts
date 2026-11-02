import './public-imports.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Dispose, HostContext, HostResult, Operation } from '@deviceforge/plugin-sdk';
import { createWorkspaceRegistry } from '../../../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../../../src/plugins/points/registry.ts';
import { createSettingsPlugin } from '../src/index.ts';
import { createSettingsServices } from '../src/services.ts';
import { connectionState, marketAddress, mcpTools } from '../src/platform.ts';

function fixture() {
  const controller = new AbortController();
  const resources = new Set<Dispose>();
  const track = (release: Dispose) => { resources.add(release); return release; };
  const workspaces = createWorkspaceRegistry(), points = createPointRegistry();
  const owner = { pluginId: 'deviceforge_settings', generation: 1, signal: controller.signal };
  let requests = 0;
  let operationsListener: ((entries: readonly Operation[]) => void) | null = null;
  let initial: ((value: HostResult<readonly Operation[]>) => void) | null = null;
  const context: HostContext = {
    apiVersion: 2, signal: controller.signal, onDispose: track,
    listOperations: () => { requests++; return new Promise((resolve) => { initial = resolve; }); },
    subscribeOperations(listener) { operationsListener = listener; return () => { operationsListener = null; }; },
    submit: async () => { throw new Error('激活不得提交业务任务'); },
    getJob: async () => { throw new Error('激活不得读取业务任务'); },
    cancelJob: async () => { throw new Error('激活不得取消业务任务'); },
    ui: workspaces.access(owner, track),
    extensions: {
      points: points.access({ ...owner, track }),
      catalog: () => ({ components: [], commands: [], modules: [], services: [] }),
      executeCommand: async () => { throw new Error('不应执行命令'); },
      callService: async () => { throw new Error('不应调用服务'); },
      subscribeEvent: () => () => undefined,
      emitEvent: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
      subscribeState: () => () => undefined,
    },
  };
  return {
    context, workspaces, points, requests: () => requests,
    revoke: () => controller.abort(),
    publish: (entries: readonly Operation[]) => { operationsListener?.(entries); },
    complete: (entries: readonly Operation[]) => { initial?.({ data: entries, logId: 'log-list' }); },
    async dispose() {
      controller.abort();
      for (const release of [...resources].reverse()) await release();
      workspaces.dispose(); points.dispose();
    },
  };
}
test('设置插件激活只登记公开页面、默认实例与设置扩展点，不联网', async () => {
  const value = fixture();
  await createSettingsPlugin({ id: 'deviceforge_settings', version: '0.1.0' }).activate?.(value.context);
  assert.equal(value.requests(), 0);
  const page = value.workspaces.catalog().pages[0];
  assert.equal(page?.route, '/settings'); assert.equal(page?.navigation?.group, '工坊');
  assert.equal(page?.navigation?.order, 110);
  assert.ok(page?.operations?.includes('plugin.settings.remote.save'));
  assert.equal(value.workspaces.snapshot().instances[0]?.instanceId, 'deviceforge_settings.editor.main');
  assert.equal(value.points.catalog().definitions[0]?.id, 'deviceforge_settings.sections');
  assert.deepEqual(value.points.catalog().definitions[0]?.modes, ['append']);
  await value.dispose();
});
test('用户关闭的默认设置实例不被重新加载强行打开，布局位置仍保留', async () => {
  const value = fixture();
  value.workspaces.hostAccess().writeLayout('deviceforge_settings.workspace', { version: 1, root: null, floating: [], overlays: [] });
  await createSettingsPlugin({ id: 'deviceforge_settings', version: '0.1.0' }).activate?.(value.context);
  assert.equal(value.workspaces.snapshot().instances.length, 0);
  assert.equal(value.workspaces.hostAccess().readLayout('deviceforge_settings.workspace')?.root, null);
  await value.dispose();
});
test('卸载撤销页面和点定义，保存布局不删除', async () => {
  const value = fixture();
  await createSettingsPlugin({ id: 'deviceforge_settings', version: '0.1.0' }).activate?.(value.context);
  value.revoke();
  assert.equal(value.workspaces.catalog().pages.length, 0);
  assert.equal(value.points.catalog().definitions.length, 0);
  assert.equal(value.workspaces.hostAccess().readLayout('deviceforge_settings.workspace')?.root?.kind, 'view');
  assert.equal(value.workspaces.snapshot().instances[0]?.reason, 'owner_inactive');
  await value.dispose();
});
test('多个设置控件共用一次惰性操作目录读取，晚到初始响应不覆盖订阅新目录', async () => {
  const value = fixture();
  const services = createSettingsServices(value.context, 'deviceforge_settings.sections', 'deviceforge_settings.workspace');
  assert.equal(value.requests(), 0);
  const stop1 = services.operations.subscribe(() => undefined), stop2 = services.operations.subscribe(() => undefined);
  assert.equal(value.requests(), 1);
  value.publish([{ id: 'plugin.settings.set', title: '保存', input_schema: {} }]);
  value.complete([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(services.operations.snapshot(), ['plugin.settings.set']);
  stop1(); stop2(); await value.dispose();
});
test('公开平台响应严格核对地址、MCP 工具与输入契约，不泄露凭据', () => {
  assert.deepEqual(connectionState({ baseUrl: 'http://127.0.0.1:7031', canReconnect: true }), {
    baseUrl: 'http://127.0.0.1:7031', canReconnect: true,
  });
  assert.throws(() => connectionState({ baseUrl: 'http://user:secret@localhost', canReconnect: true }));
  assert.equal(marketAddress({ url: 'http://localhost:7040/' }), 'http://localhost:7040');
  assert.throws(() => marketAddress({ url: 'file:///C:/market' }));
  assert.equal(mcpTools({ tools: [{ name: 'test', inputSchema: { type: 'object' } }] }).length, 1);
  assert.throws(() => mcpTools({ tools: [{ name: 'test', inputSchema: 'object' }] }));
});
