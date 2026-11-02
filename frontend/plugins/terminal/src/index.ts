import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';
import { createTerminalInstances } from './instances.ts';

export default function createTerminalPlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      const instances = createTerminalInstances(context, identity.id);
      registerBusinessWorkspace(context, {
        pluginId: identity.id, title: '终端', route: '/terminal',
        navigation: { group: '深度调试', order: 60, icon: 'terminal', description: '有状态交互终端与保留输出' },
        operations: ['plugin.terminal.open'], provides: ['terminal.workspace'],
        async mount(target, current, instance) {
          current.signal.throwIfAborted();
          const services = instances.retain(instance.snapshot());
          const view = await import('./view.tsx');
          current.signal.throwIfAborted();
          return view.mountTerminal(target, services, instance);
        },
      });
    },
  };
}
