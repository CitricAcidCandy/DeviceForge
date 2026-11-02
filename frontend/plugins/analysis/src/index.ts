import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';

export default function createAnalysisPlugin(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      registerBusinessWorkspace(context, {
        pluginId: identity.id, title: '数据分析', route: '/analysis',
        navigation: { group: '扩展创作', order: 80, icon: 'scan', description: 'DEX 与 MessagePack 离线分析' },
        operations: ['plugin.dex-analysis.inspect', 'plugin.dex-analysis.scan_sdks',
          'plugin.msgpack.encode', 'plugin.msgpack.decode', 'plugin.msgpack.query'],
        provides: ['analysis.workspace'],
        async mount(target, current) {
          const view = await import('./view.tsx');
          current.signal.throwIfAborted();
          return view.mountAnalysis(target, current);
        },
      });
    },
  };
}
