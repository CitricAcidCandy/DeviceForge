import { HostError } from '@deviceforge/plugin-sdk';
import type { WebPlugin } from '@deviceforge/plugin-sdk';
import { registerBusinessWorkspace } from '@deviceforge/business-kit/workspace';
import { createMarketplace } from './model/index.ts';
export interface MarketplacePluginIdentity { readonly id: string; readonly version: string; readonly apiVersion?: 2 }

/** 激活只登记公开能力；管理依赖齐备后开放页面，首次挂载才创建业务模型。 */
export function createMarketplacePlugin(identity: MarketplacePluginIdentity): WebPlugin {
  return {
    ...identity, apiVersion: 2, panels: [],
    async activate(context) {
      if (!context.extensions?.register) throw new Error('市场插件需要公开动态贡献注册');
      const marketplace = createMarketplace();
      context.onDispose(marketplace.dispose);
      context.extensions.register({ services: [{
        id: `${identity.id}.preferences`, version: '1',
        inputSchema: {
          oneOf: [
            { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { enum: ['get', 'reset'] } } },
            { type: 'object', required: ['action', 'url'], additionalProperties: false, properties: { action: { const: 'set' }, url: { type: 'string', maxLength: 2048 } } },
          ],
        },
        outputSchema: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string' } } },
        async invoke(input, _host, signal) {
          signal.throwIfAborted();
          if (!input || typeof input !== 'object' || Array.isArray(input) || !('action' in input))
            throw new HostError('protocol', 'invalid_market_preferences', '市场地址操作无效');
          if (input.action === 'get') return { data: { url: marketplace.currentUrl() }, logId: null };
          if (input.action === 'reset') return { data: { url: marketplace.resetUrl() }, logId: null };
          if (input.action === 'set' && typeof input.url === 'string')
            return { data: { url: marketplace.setUrl(input.url) }, logId: null };
          throw new HostError('protocol', 'invalid_market_preferences', '市场地址操作无效');
        },
      }] });
      if (!context.ui || !context.services) return;
      const release = context.services.whenAvailable(`${identity.id}.workbench`, [
        { id: 'host.browser-plugins', version: '1' },
        { id: 'host.ui-directory', version: '1' },
      ], (current) => {
        registerBusinessWorkspace(current, {
          pluginId: identity.id, title: '市场', route: '/marketplace',
          navigation: { group: '工坊', order: 100, icon: 'store', description: '安装、管理及发布插件和工具' },
          operations: ['plugin.tool-supply.import'],
          provides: ['marketplace.workspace'],
          async mount(target, host, instance) {
            const view = await import('./view.tsx');
            host.signal.throwIfAborted();
            return view.mountMarketplace(target, host, instance, marketplace);
          },
        });
      });
      context.onDispose(release);
    },
  };
}
export default createMarketplacePlugin;
