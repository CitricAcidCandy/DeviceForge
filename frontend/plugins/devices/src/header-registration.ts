import type { Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { DEVICES_PLUGIN_ID } from './contracts.ts';

export const DEVICE_HEADER_VIEW = `${DEVICES_PLUGIN_ID}.header`;
export const DEVICE_HEADER_POINT = Object.freeze({ id: 'deviceforge_shell.header', version: '1' });

/** 默认外壳尚未出现时贡献等待；设备页面与其他功能不依赖外壳是否启用。 */
export function registerDeviceHeader(context: HostContext): Dispose {
  const ui = context.ui, points = context.extensions?.points;
  if (!ui || !points) return () => {};
  const releaseView = ui.register({ views: [{
    id: DEVICE_HEADER_VIEW, title: '当前设备', provides: ['device.context'],
    mount: async (target, mounted) => {
      const module = await import('./header.tsx');
      mounted.signal.throwIfAborted();
      return module.mountDeviceHeader(target, mounted);
    },
  }] });
  try {
    const releaseContribution = points.contribute({
      id: `${DEVICES_PLUGIN_ID}.header.contribution`, point: DEVICE_HEADER_POINT, mode: 'append',
      data: { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_HEADER_VIEW },
    }).dispose;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { await releaseContribution(); }
      finally { await releaseView(); }
    };
  } catch (error) { void releaseView(); throw error; }
}
