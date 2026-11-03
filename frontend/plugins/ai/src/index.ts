import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';
import type { createAiInstances } from './instances.ts';
import { registerAiPublicServices } from './public-services/index.ts';
export { aiPublicServiceRefs } from './public-services/index.ts';

export default function createAiPlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      if (!context.ui || !context.transport || !context.onCleanup)
        throw new Error('AI需要公开工作区、通信和有界清理能力，不会接管旧AI页面');
      let instances: ReturnType<typeof createAiInstances> | null = null;
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
          const [view, models] = await Promise.all([import('./view.tsx'), import('./instances.ts')]);
          current.signal.throwIfAborted();
          context.signal.throwIfAborted();
          instances ??= models.createAiInstances(context, identity.id);
          const services = instances.retain(instance.snapshot());
          return view.mountAi(target, services, instance);
        },
      });
    },
  };
}
