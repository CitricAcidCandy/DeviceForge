import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceInstance, WorkspaceLayoutNode, WorkspaceSnapshot, WorkspaceViewInfo } from '../src/plugin-sdk/index.ts';
import { legacyWorkspacePage, legacyWorkspaceSlot } from '../src/app/composition/legacy-workspace-slots.ts';

const instance: WorkspaceInstance = {
  instanceId: 'deviceforge_devices.apps.main', pluginId: 'deviceforge_devices',
  workspaceId: 'deviceforge_devices.workspace',
  provider: { pluginId: 'independent_apps', viewId: 'independent_apps.view' },
  target: null, visible: true, generation: 3, providerGeneration: 7, state: 'ready', reason: null,
};
const view: WorkspaceViewInfo = {
  id: 'independent_apps.view', pluginId: 'independent_apps', generation: 7,
  title: '独立应用视图', provides: ['device.apps'],
};

test('旧应用槽位按原主实例和公开能力匹配，不限定官方插件身份', () => {
  assert.equal(legacyWorkspaceSlot(instance, [view]), 'devices.apps');
  const custom = { ...view, pluginId: 'third_party', id: 'third_party.apps' };
  assert.equal(legacyWorkspaceSlot({ ...instance,
    provider: { pluginId: custom.pluginId, viewId: custom.id },
  }, [custom]), 'devices.apps');
  assert.equal(legacyWorkspaceSlot({ ...instance, instanceId: 'deviceforge_devices.tool.1' }, [view]), null);
});

test('旧槽位不匹配缺失、异代、非应用或非同名视图，不抢占额外实例', () => {
  assert.equal(legacyWorkspaceSlot({ ...instance, provider: null }, [view]), null);
  assert.equal(legacyWorkspaceSlot(instance, []), null);
  assert.equal(legacyWorkspaceSlot(instance, [{ ...view, generation: 6 }]), null);
  assert.equal(legacyWorkspaceSlot(instance, [{ ...view, provides: [] }]), null);
  assert.equal(legacyWorkspaceSlot(instance, [{ ...view, id: 'independent_apps.other' }]), null);
  assert.equal(legacyWorkspaceSlot(instance, [{ ...view, pluginId: 'other_apps' }]), null);
});

const pageInstance: WorkspaceInstance = {
  ...instance, instanceId: 'business.main.default', pluginId: 'business', workspaceId: 'business.workspace',
  provider: { pluginId: 'business', viewId: 'business.main' }, providerGeneration: 7,
};
function pageSnapshot(root: WorkspaceLayoutNode): WorkspaceSnapshot {
  return {
    revision: 1,
    catalog: {
      pages: [{ id: 'business.page', pluginId: 'business', generation: 7, title: '业务',
        route: '/devices', workspaceId: 'business.workspace', viewId: null }],
      workspaces: [{ id: 'business.workspace', pluginId: 'business', generation: 7, title: '业务工作区' }],
      views: [{ id: 'business.main', pluginId: 'business', generation: 7, title: '主视图', provides: [] }],
    },
    instances: [pageInstance, { ...pageInstance, instanceId: 'business.extra' }],
    layouts: [{ workspaceId: 'business.workspace', layout: { version: 1, root, floating: [{
      instanceId: 'business.extra', x: 0, y: 0, width: 240, height: 160, z: 1,
    }], overlays: [] } }],
  };
}

test('旧路由按公开页面和主布局匹配，第三方追加及浮窗不重复占用', () => {
  const snapshot = pageSnapshot({ kind: 'split', direction: 'horizontal', weights: [3, 1], children: [
    { kind: 'tabs', active: 'original', items: [{ id: 'original', title: '原工作区',
      node: { kind: 'view', instanceId: pageInstance.instanceId } }] },
    { kind: 'view', instanceId: 'third_party.extra' },
  ] });
  const thirdParty: WorkspaceInstance = { ...pageInstance, instanceId: 'third_party.extra',
    provider: { pluginId: 'third_party', viewId: 'third_party.main' } };
  const combined = { ...snapshot, instances: [...snapshot.instances, thirdParty] };
  assert.equal(legacyWorkspacePage(pageInstance, combined)?.id, 'business.page');
  assert.equal(legacyWorkspacePage({ ...pageInstance, instanceId: 'business.extra' }, combined), null);
  assert.equal(legacyWorkspacePage(thirdParty, combined), null);
});

test('旧路由不穿透自定义布局或猜测多个业务主实例，缺失和旧代不能建立槽位', () => {
  const root: WorkspaceLayoutNode = { kind: 'view', instanceId: pageInstance.instanceId };
  const snapshot = pageSnapshot(root);
  assert.equal(legacyWorkspacePage(pageInstance, pageSnapshot({ kind: 'custom',
    provider: { pluginId: 'custom', viewId: 'custom.layout' }, data: null, children: [root],
  })), null);
  assert.equal(legacyWorkspacePage(pageInstance, pageSnapshot({ kind: 'split', direction: 'horizontal', weights: [1, 1],
    children: [root, { kind: 'view', instanceId: 'business.extra' }],
  })), null);
  assert.equal(legacyWorkspacePage(pageInstance, { ...snapshot, layouts: [] }), null);
  assert.equal(legacyWorkspacePage(pageInstance, { ...snapshot, catalog: { ...snapshot.catalog,
    pages: snapshot.catalog.pages.map((page) => ({ ...page, generation: 6 })),
  } }), null);
  assert.equal(legacyWorkspacePage({ ...pageInstance, state: 'missing', reason: 'owner_inactive' }, snapshot), null);
});
