import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';
import { registerPerformancePublicService } from './public-service.ts';

export default function createPerformancePlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      registerPerformancePublicService(context, identity.id);
      registerBusinessWorkspace(context, {
        pluginId: identity.id, title: '性能与调用栈', route: '/performance',
        navigation: { group: '深度调试', order: 30, icon: 'activity', description: '实时指标、采样画面与 Root 性能归档' },
        operations: ['android.performance.start', 'android.performance.inspect', 'android.performance.samples',
          'android.performance.pause', 'android.performance.resume', 'android.performance.stop',
          'android.performance.list', 'android.performance.capabilities', 'plugin.android-device.stack.probe',
          'plugin.android-device.profile.record'],
        provides: ['performance.workspace'],
        async mount(target, current) {
          const view = await import('./view.tsx');
          current.signal.throwIfAborted();
          return view.mountPerformance(target, current);
        },
      });
    },
  };
}
