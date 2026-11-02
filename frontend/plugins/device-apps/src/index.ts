import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { createDeviceAppsInstances } from './instances.ts';
export { DEVICE_APPS_PLUGIN_ID, DEVICE_APPS_VIEW_ID, DEVICE_APPS_VIEW } from './contracts.ts';

export default function createDeviceAppsPlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      const ui = context.ui;
      if (!ui) throw new Error('设备应用视图需要公开工作区能力');
      const instances = createDeviceAppsInstances(context, identity.id);
      ui.register({
        views: [{
          id: `${identity.id}.main`, title: '设备应用', provides: ['device.apps'],
          async mount(target, current, instance) {
            current.signal.throwIfAborted();
            instance.signal.throwIfAborted();
            const services = instances.retain(instance.snapshot());
            const { mountDeviceApps } = await import('./view.tsx');
            current.signal.throwIfAborted();
            instance.signal.throwIfAborted();
            return mountDeviceApps(target, services, instance);
          },
        }],
      });
      context.extensions?.points?.contribute({
        id: `${identity.id}.task-operations`,
        point: { id: 'deviceforge_devices.task-operations', version: '1' }, mode: 'append',
        data: { operations: ['manifest', 'signature', 'extract_apk', 'build_apks', 'decode', 'scan_sdks', 'extract_splits']
          .map((action) => `plugin.android-packages.${action}`) },
      });
    },
  };
}
