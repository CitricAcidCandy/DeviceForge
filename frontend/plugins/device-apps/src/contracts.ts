import type { WorkspaceViewRef } from '@deviceforge/plugin-sdk';

export const DEVICE_APPS_PLUGIN_ID = 'deviceforge_device_apps';
export const DEVICE_APPS_VIEW_ID = `${DEVICE_APPS_PLUGIN_ID}.main`;
export const DEVICE_APPS_VIEW: WorkspaceViewRef = {
  pluginId: DEVICE_APPS_PLUGIN_ID, viewId: DEVICE_APPS_VIEW_ID,
};
