import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';
import { createAiInstances } from './instances.ts';
import { registerAiPublicServices } from './public-services/index.ts';
export { aiPublicServiceRefs } from './public-services/index.ts';

export default function createAiPlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      const instances = createAiInstances(context, identity.id);
      context.onDispose(registerAiPublicServices(context, identity.id));
      registerBusinessWorkspace(context, {
        pluginId: identity.id, title: 'AI 助手', route: '/ai',
        navigation: { group: '扩展创作', order: 70, icon: 'sparkles', description: 'SDK 与 CLI 对话及实时会话' },
        operations: [
          ...['runtime.status', 'sdk.single', 'sdk.turn', 'session.get', 'session.close', 'assistant.run']
            .map((action) => `plugin.ai-sdk.${action}`),
          ...['runtime.status', 'cli.single', 'cli.turn', 'session.get', 'session.close']
            .map((action) => `plugin.ai-assistant.${action}`),
        ],
        provides: ['ai.workspace'],
        async mount(target, current, instance) {
          current.signal.throwIfAborted();
          const services = instances.retain(instance.snapshot());
          const view = await import('./view.tsx');
          current.signal.throwIfAborted();
          return view.mountAi(target, services, instance);
        },
      });
    },
  };
}
