import type { HostContext, JsonValue, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import {
  DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW, DEVICE_DIRECTORY_INSTANCE_ID, DEVICE_DIRECTORY_VIEW_ID,
  DEVICE_SCREEN_INSTANCE_ID, DEVICE_SCREEN_VIEW, DEVICES_PLUGIN_ID, DEVICES_WORKSPACE_ID,
  DEVICE_WORKBENCH_INSTANCE_ID, acceptsDeviceTarget, deviceTarget, screenWorkbenchTarget,
  targetReference, updateDeviceReference,
} from './contracts.ts';

/** 子视图属于本次工作台挂载，不作为最终用户需要手工摆放的布局节点。 */
export function createWorkbenchChildren(context: HostContext, parent: WorkspaceViewContext) {
  const ui = context.ui;
  if (!ui?.mount) throw new Error('当前平台没有工作区视图渲染能力');
  const snapshot = parent.snapshot();
  const reference = targetReference(snapshot.target);
  const primary = snapshot.instanceId === DEVICE_WORKBENCH_INSTANCE_ID;
  // 已撤销的自有编号可重用，避免热重载不断积累不属于布局的嵌套占位。
  const retained = new Set(ui.snapshot().instances.filter((instance) =>
    instance.pluginId !== DEVICES_PLUGIN_ID || instance.reason !== 'owner_inactive').map((instance) => instance.instanceId));
  let ordinal = 1;
  while (['screen', 'apps', 'directory'].some((kind) => retained.has(`${DEVICES_PLUGIN_ID}.${kind}.nested.${ordinal}`))) ordinal++;
  const suffix = primary ? 'main' : `nested.${ordinal}`;
  const screenInstanceId = primary ? DEVICE_SCREEN_INSTANCE_ID : `${DEVICES_PLUGIN_ID}.screen.${suffix}`;
  const applicationsInstanceId = primary ? DEVICE_APPS_INSTANCE_ID : `${DEVICES_PLUGIN_ID}.apps.${suffix}`;
  const directoryInstanceId = primary ? DEVICE_DIRECTORY_INSTANCE_ID : `${DEVICES_PLUGIN_ID}.directory.${suffix}`;
  const specifications = [
    { id: screenInstanceId, provider: DEVICE_SCREEN_VIEW, target: screenWorkbenchTarget(reference, applicationsInstanceId) },
    { id: applicationsInstanceId, provider: DEVICE_APPS_VIEW, target: deviceTarget(reference) },
    { id: directoryInstanceId, provider: { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_DIRECTORY_VIEW_ID }, target: deviceTarget(reference) },
  ];
  const opened: { readonly id: string; readonly generation: number }[] = [];
  try {
    for (const specification of specifications) {
      const previous = ui.snapshot().instances.find((instance) => instance.instanceId === specification.id);
      if (previous?.pluginId && previous.pluginId !== DEVICES_PLUGIN_ID)
        throw new Error('设备工作台子实例被其他所有者占用');
      let target: JsonValue = specification.target;
      if (primary && previous) {
        target = acceptsDeviceTarget(previous.target) ? updateDeviceReference(previous.target, reference) : previous.target;
        if (specification.id === screenInstanceId && target && typeof target === 'object' &&
            !Array.isArray(target) && target.kind === 'device' && !('presentation' in target))
          target = { ...target, presentation: { version: 1, applicationsInstanceId } };
      }
      if (previous) ui.close(specification.id);
      const instance = ui.open({
        instanceId: specification.id, workspaceId: DEVICES_WORKSPACE_ID,
        provider: primary && previous ? previous.provider : specification.provider,
        target, visible: false,
      }, parent.signal);
      opened.push({ id: instance.instanceId, generation: instance.generation });
    }
  } catch (error) {
    for (const instance of opened) {
      try { ui.close(instance.id); } catch { /* 原始装配失败保留，所属作用域仍负责撤销。 */ }
    }
    throw error;
  }
  const visible = (instanceId: string, next: boolean) => {
    if (context.signal.aborted || parent.signal.aborted) return;
    const instance = ui.snapshot().instances.find((item) => item.instanceId === instanceId);
    if (instance && instance.visible !== next) ui.setVisible(instanceId, next);
  };
  const synchronize = (next: boolean) => {
    visible(screenInstanceId, next);
    if (!next) {
      visible(applicationsInstanceId, false);
      visible(directoryInstanceId, false);
    }
  };
  const unsubscribe = parent.subscribeVisibility(synchronize);
  synchronize(parent.snapshot().visible);
  return {
    ui,
    screenInstanceId, applicationsInstanceId, directoryInstanceId,
    setDirectoryVisible: (next: boolean) => visible(directoryInstanceId, next && parent.snapshot().visible),
    dispose() { void unsubscribe(); },
    owned: () => opened,
  };
}
