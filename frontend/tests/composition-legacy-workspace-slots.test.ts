import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceInstance, WorkspaceViewInfo } from '../src/plugin-sdk/index.ts';
import { legacyWorkspaceSlot } from '../src/app/composition/legacy-workspace-slots.ts';

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
