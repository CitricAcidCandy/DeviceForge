import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';
import { fridaActions, fridaOperation } from './model/models/catalog.ts';

export default function createFridaPlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      registerBusinessWorkspace(context, {
        pluginId: identity.id, title: 'Frida', route: '/frida',
        navigation: { group: '深度调试', order: 40, icon: 'code', description: '服务器状态、进程与脚本输出' },
        operations: fridaActions.map(fridaOperation), provides: ['frida.workspace'],
        async mount(target, current, instance) {
          const view = await import('./view.tsx');
          current.signal.throwIfAborted();
          return view.mountFrida(target, current, instance);
        },
      });
    },
  };
}
