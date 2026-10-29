import type { WebPlugin } from '@deviceforge/plugin-sdk';

interface PluginIdentity { readonly id: string; readonly version: string; readonly apiVersion: 2 }
/** 身份与版本由单一manifest的打包入口注入。 */
export default function createDefaultShell(identity: PluginIdentity): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context) {
      const ui = context.ui, points = context.extensions?.points;
      if (!ui?.mount || !points) throw new Error('默认工作区需要公开工作区挂载与扩展点能力');
      context.onDispose(ui.register({
        views: [{
          id: `${identity.id}.root`, title: '默认工作区', provides: ['host.shell'],
          mount: async (target, host) => (await import('./mount.tsx')).mountShell(target, host),
        }],
      }));
      const schema = {
        type: 'object', required: ['pluginId', 'viewId'], additionalProperties: false,
        properties: { pluginId: { type: 'string', minLength: 1 }, viewId: { type: 'string', minLength: 1 } },
      };
      for (const region of ['header', 'sidebar', 'footer'])
        context.onDispose(points.define({ id: `${identity.id}.${region}`, version: '1', title: `默认工作区${region === 'header' ? '顶栏' : region === 'sidebar' ? '侧栏' : '底栏'}`, modes: ['append'], inputSchema: schema }));
      context.onDispose(points.contribute({
        id: `${identity.id}.shell`, point: { id: 'host.shell', version: '1' }, mode: 'replace',
        data: { pluginId: identity.id, viewId: `${identity.id}.root` },
      }).dispose);
    },
  };
}
