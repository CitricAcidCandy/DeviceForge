import type { HostContext, WebPlugin, WorkspaceMount } from '@deviceforge/plugin-sdk';
import {
  DEFAULT_DEVICE_LAYOUT, DEVICE_DIRECTORY_VIEW_ID, DEVICE_TARGET_EVENT, DEVICE_TARGET_SERVICE,
  DEVICE_TOOLS_POINT, DEVICE_WORKBENCH_VIEW_ID, DEVICES_PLUGIN_ID, DEVICES_WORKSPACE_ID,
  deviceIdentity, deviceTarget,
} from './contracts.ts';
import { migrateDeviceAppProvider, restoreDeviceInstances, synchronizeDeviceTargets } from './model.ts';
import { clearRetainedDeviceTools, synchronizeDeviceTools } from './tools.ts';
import { migrateDeviceWorkbenchLayout } from './workbench-layout.ts';
import { registerDevicePage } from './page-metadata.ts';
import { registerDeviceHeader } from './header-registration.ts';
import { startInitialDirectoryRead } from './initial-directory.ts';

export * from './contracts.ts';

const mountDirectory: WorkspaceMount = async (target, context, instance) => {
  const module = await import('./view.tsx');
  context.signal.throwIfAborted();
  instance.signal.throwIfAborted();
  return module.mountDirectory(target, context, instance);
};
function registerTarget(context: HostContext) {
  context.extensions?.register?.({
    services: [{
      ...DEVICE_TARGET_SERVICE,
      invoke: async (_input, caller, signal) => {
        signal.throwIfAborted();
        return { data: deviceTarget(caller.devices?.snapshot().selection ?? null), logId: null };
      },
    }],
  });
  let previous = deviceIdentity(context.devices?.snapshot().selection ?? null);
  const dispose = context.devices?.subscribe((snapshot) => {
    const next = deviceIdentity(snapshot.selection);
    if (previous === next || context.signal.aborted) return;
    previous = next;
    context.extensions?.emitEvent(DEVICE_TARGET_EVENT, deviceTarget(snapshot.selection));
  });
  if (dispose) context.onDispose(dispose);
}

export default function createDevicesPlugin(
  identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>,
): WebPlugin {
  if (identity.id !== DEVICES_PLUGIN_ID) throw new Error('设备插件身份与稳定工作区命名空间不一致');
  return {
    ...identity,
    panels: [],
    async activate(context) {
      const ui = context.ui;
      if (!ui) throw new Error('设备插件需要公开工作区能力');
      migrateDeviceAppProvider(ui);
      ui.register({
        workspaces: [{ id: DEVICES_WORKSPACE_ID, title: '设备工作区', defaultLayout: DEFAULT_DEVICE_LAYOUT }],
        views: [
          { id: DEVICE_DIRECTORY_VIEW_ID, title: '设备目录', provides: ['device.directory'], mount: mountDirectory },
          {
            id: DEVICE_WORKBENCH_VIEW_ID, title: '设备工作台', provides: ['device.workbench'],
            mount: async (target, mounted, instance) => {
              const module = await import('./workbench.tsx');
              mounted.signal.throwIfAborted();
              instance.signal.throwIfAborted();
              return module.mountWorkbench(target, mounted, instance, (owned) => {
                if (context.signal.aborted) return;
                for (const child of owned) {
                  if (ui.snapshot().instances.some((current) => current.instanceId === child.id &&
                      current.generation === child.generation)) ui.close(child.id);
                }
              });
            },
          },
        ],
      });
      context.onDispose(registerDevicePage(context));
      context.extensions?.points?.define({
        ...DEVICE_TOOLS_POINT, title: '设备工作区工具', modes: ['append'],
        inputSchema: {
          type: 'object', required: ['pluginId', 'viewId', 'title'], additionalProperties: false,
          properties: {
            pluginId: { type: 'string', minLength: 1, maxLength: 128 },
            viewId: { type: 'string', minLength: 1, maxLength: 200 },
            title: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
      });
      clearRetainedDeviceTools(ui);
      migrateDeviceWorkbenchLayout(ui);
      restoreDeviceInstances(context, ui);
      context.onDispose(synchronizeDeviceTargets(context, ui));
      context.onDispose(synchronizeDeviceTools(context));
      registerTarget(context);
      context.onDispose(registerDeviceHeader(context));
      context.onDispose(startInitialDirectoryRead(context));
    },
  };
}
