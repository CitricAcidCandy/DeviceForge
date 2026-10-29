import type { HostContext, WebPlugin, WorkspaceLayoutNode } from '@deviceforge/plugin-sdk';

export interface TasksPluginIdentity { readonly id: string; readonly version: string }

function includes(node: WorkspaceLayoutNode | null, id: string): boolean {
  if (!node) return false;
  if (node.kind === 'view') return node.instanceId === id;
  if (node.kind === 'tabs') return node.items.some((entry) => includes(entry.node, id));
  return node.children?.some((entry) => includes(entry, id)) ?? false;
}
/** 装配端从唯一开发清单注入身份；独立插件不读取宿主或重复维护版本。 */
export function createTasksPlugin(identity: TasksPluginIdentity): WebPlugin {
  const workspaceId = `${identity.id}.workspace`;
  const viewId = `${identity.id}.list`;
  const instanceId = `${identity.id}.list.main`;
  const pointId = `${identity.id}.toolbar`;
  async function mount(target: HTMLElement, context: HostContext) {
    const view = await import('./view.tsx');
    context.signal.throwIfAborted();
    return view.mountTasks(target, context, pointId);
  }
  return {
    ...identity, apiVersion: 2, panels: [],
    async activate(context) {
      const ui = context.ui;
      if (!ui) throw new Error('任务插件需要支持公开工作区的宿主');
      ui.register({
        workspaces: [{
          id: workspaceId, title: '任务工作区',
          defaultLayout: {
            version: 1, root: { kind: 'view', instanceId }, floating: [], overlays: [],
          },
        }],
        views: [{ id: viewId, title: '任务与日志', provides: ['tasks.history'], mount }],
        pages: [{
          id: `${identity.id}.page`, title: '任务与日志', route: '/tasks', workspaceId,
          navigation: { group: '工坊', order: 10, icon: 'list-checks', description: '查看后台任务、请求日志与可下载产物' },
          taskPolicy: 'all',
        }],
      });
      context.extensions?.points?.define({
        id: pointId, version: '1.0', title: '任务工具', modes: ['append'],
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
export default createTasksPlugin;
