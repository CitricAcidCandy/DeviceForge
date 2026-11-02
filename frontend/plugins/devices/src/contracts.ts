import type {
  DeviceRef, JsonValue, PointRef, WorkspaceLayout, WorkspaceViewRef,
} from '@deviceforge/plugin-sdk';

export const DEVICES_PLUGIN_ID = 'deviceforge_devices';
export const DEVICES_WORKSPACE_ID = 'deviceforge_devices.workspace';
export const DEVICE_DIRECTORY_VIEW_ID = 'deviceforge_devices.directory';
export const DEVICE_DIRECTORY_INSTANCE_ID = 'deviceforge_devices.directory.main';
export const DEVICE_SCREEN_INSTANCE_ID = 'deviceforge_devices.screen.main';
export const DEVICE_APPS_INSTANCE_ID = 'deviceforge_devices.apps.main';
export const DEVICE_WORKBENCH_VIEW_ID = 'deviceforge_devices.workbench';
export const DEVICE_WORKBENCH_INSTANCE_ID = 'deviceforge_devices.workbench.main';
export const DEVICE_TOOLS_POINT: PointRef = { id: 'deviceforge_devices.tools', version: '1' };
export const DEVICE_TASKS_POINT: PointRef = { id: 'deviceforge_devices.task-operations', version: '1' };
export const DEVICE_TARGET_SERVICE = { id: 'deviceforge_devices.target', version: '1' };
export const DEVICE_TARGET_EVENT = 'deviceforge_devices.target.changed';
export const DEVICE_WORKBENCH_PANE_EVENT = 'deviceforge_devices.workbench.pane';

/** 画面仍由过渡适配提供；应用实现由独立插件拥有。 */
export const DEVICE_SCREEN_VIEW: WorkspaceViewRef = {
  pluginId: 'deviceforge_device_views', viewId: 'deviceforge_device_views.screen',
};
export const DEVICE_APPS_VIEW: WorkspaceViewRef = {
  pluginId: 'deviceforge_device_apps', viewId: 'deviceforge_device_apps.main',
};
export const LEGACY_DEVICE_APPS_VIEW: WorkspaceViewRef = {
  pluginId: 'deviceforge_device_views', viewId: 'deviceforge_device_views.apps',
};
export const DEFAULT_DEVICE_LAYOUT: WorkspaceLayout = {
  version: 1,
  root: { kind: 'view', instanceId: DEVICE_WORKBENCH_INSTANCE_ID },
  floating: [], overlays: [],
};

export type DeviceTarget = {
  readonly kind: 'device';
  readonly reference: {
    readonly providerId: string;
    readonly generation: string;
    readonly localId: string;
  } | null;
};
export function deviceTarget(reference: DeviceRef | null): DeviceTarget {
  return {
    kind: 'device',
    reference: reference ? {
      providerId: reference.providerId, generation: reference.generation, localId: reference.localId,
    } : null,
  };
}
export function screenWorkbenchTarget(reference: DeviceRef | null, applicationsInstanceId = DEVICE_APPS_INSTANCE_ID): JsonValue {
  return {
    ...deviceTarget(reference),
    presentation: { version: 1, applicationsInstanceId },
  };
}
export function screenApplicationsInstance(value: JsonValue): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'device') return null;
  const presentation = value.presentation;
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation) ||
      presentation.version !== 1 || typeof presentation.applicationsInstanceId !== 'string' ||
      !presentation.applicationsInstanceId || presentation.applicationsInstanceId.length > 200) return null;
  return presentation.applicationsInstanceId;
}
export function updateDeviceReference(value: JsonValue, reference: DeviceRef | null): JsonValue {
  return value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'device'
    ? { ...value, reference: deviceTarget(reference).reference } : deviceTarget(reference);
}
export function targetReference(value: JsonValue): DeviceRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'device') return null;
  const reference = value.reference;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) ||
      typeof reference.providerId !== 'string' || typeof reference.generation !== 'string' ||
      typeof reference.localId !== 'string') return null;
  return { providerId: reference.providerId, generation: reference.generation, localId: reference.localId };
}
export function acceptsDeviceTarget(value: JsonValue): boolean {
  return value === null || typeof value === 'object' && !Array.isArray(value) && value.kind === 'device';
}
export function deviceIdentity(reference: DeviceRef | null): string {
  return reference ? JSON.stringify([reference.providerId, reference.generation, reference.localId]) : '';
}
export function sameDevice(left: DeviceRef | null, right: DeviceRef | null): boolean {
  return deviceIdentity(left) === deviceIdentity(right);
}
export function toolView(value: JsonValue): WorkspaceViewRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.pluginId === 'string' && value.pluginId.length > 0 &&
    typeof value.viewId === 'string' && value.viewId.length > 0
    ? { pluginId: value.pluginId, viewId: value.viewId } : null;
}
