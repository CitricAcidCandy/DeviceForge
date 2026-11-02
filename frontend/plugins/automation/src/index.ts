import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';
import { automationActions, automationOperation } from './model/models/catalog.ts';

export default function createAutomationPlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      registerBusinessWorkspace(context, {
        pluginId: identity.id, title: '自动化', route: '/automation',
        navigation: { group: '深度调试', order: 50, icon: 'workflow', description: '设备步骤、桌面操作与输入录制回放' },
        operations: automationActions.map(automationOperation), provides: ['automation.workspace'],
        async mount(target, current) {
          const view = await import('./view.tsx');
          current.signal.throwIfAborted();
          return view.mountAutomation(target, current);
        },
      });
    },
  };
}
