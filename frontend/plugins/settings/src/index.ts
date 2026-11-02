import type { HostContext, WebPlugin, WorkspaceLayoutNode } from '@deviceforge/plugin-sdk';

export interface SettingsPluginIdentity { readonly id: string; readonly version: string; readonly apiVersion?: 2 }
function includes(node: WorkspaceLayoutNode | null, id: string): boolean {
  if (!node) return false;
  if (node.kind === 'view') return node.instanceId === id;
  if (node.kind === 'tabs') return node.items.some((entry) => includes(entry.node, id));
  return node.children?.some((entry) => includes(entry, id)) ?? false;
}
/** 身份只从开发清单注入；激活登记功能，不自动读取或写入用户配置。 */
export function createSettingsPlugin(identity: SettingsPluginIdentity): WebPlugin {
  const workspaceId = `${identity.id}.workspace`, viewId = `${identity.id}.editor`;
  const instanceId = `${identity.id}.editor.main`, sectionsId = `${identity.id}.sections`;
  async function mount(target: HTMLElement, context: HostContext) {
    const view = await import('./view.tsx');
    context.signal.throwIfAborted();
    return view.mountSettings(target, context, sectionsId, workspaceId);
  }
  return {
    id: identity.id, version: identity.version, apiVersion: 2, panels: [],
    async activate(context) {
      const ui = context.ui;
      if (!ui) throw new Error('设置插件需要公开工作区能力');
      ui.register({
        workspaces: [{
          id: workspaceId, title: '设置工作区',
          defaultLayout: { version: 1, root: { kind: 'view', instanceId }, floating: [], overlays: [] },
        }],
        views: [{ id: viewId, title: '设置', provides: ['settings.editor'], mount }],
        pages: [{
          id: `${identity.id}.page`, title: '设置', route: '/settings', workspaceId,
          navigation: { group: '工坊', order: 110, icon: 'settings-2', description: '服务连接、外观主题和修订配置' },
          operations: ['list', 'get', 'set', 'delete', 'import', 'remote.load', 'remote.save'].map((action) => `plugin.settings.${action}`),
        }],
      });
      context.extensions?.points?.define({
        id: sectionsId, version: '1', title: '设置扩展', modes: ['append'],
        inputSchema: {
          type: 'object', required: ['title', 'view'], additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 80 },
            view: {
              type: 'object', required: ['pluginId', 'viewId'], additionalProperties: false,
              properties: { pluginId: { type: 'string' }, viewId: { type: 'string' } },
            },
          },
        },
      });
      const layout = ui.readLayout(workspaceId);
      if (layout && (includes(layout.root, instanceId) ||
          [...layout.floating, ...layout.overlays].some((entry) => entry.instanceId === instanceId)))
        ui.open({ instanceId, workspaceId, provider: { pluginId: identity.id, viewId } }, context.signal);
    },
  };
}
export default createSettingsPlugin;
