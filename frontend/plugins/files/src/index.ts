import type {
  HostContext, WebPlugin, WorkspaceLayout, WorkspaceLayoutNode,
} from '@deviceforge/plugin-sdk';
import { registerFilesTools } from './tools.ts';
export { FILES_TOOLS_POINT } from './tools.ts';

export const FILES_PLUGIN_ID = 'deviceforge_files';
export const FILES_WORKSPACE_ID = 'deviceforge_files.workspace';
export const FILES_VIEW_ID = 'deviceforge_files.browser';
export const FILES_INSTANCE_ID = 'deviceforge_files.browser.main';

function includes(node: WorkspaceLayoutNode | null, instanceId: string): boolean {
  if (!node) return false;
  if (node.kind === 'view') return node.instanceId === instanceId;
  if (node.kind === 'split') return node.children.some((child) => includes(child, instanceId));
  if (node.kind === 'tabs') return node.items.some((item) => includes(item.node, instanceId));
  return node.children?.some((child) => includes(child, instanceId)) ?? false;
}
function references(layout: WorkspaceLayout | null, instanceId: string) {
  return Boolean(layout && (includes(layout.root, instanceId) ||
    [...layout.floating, ...layout.overlays].some((item) => item.instanceId === instanceId)));
}
async function mount(target: HTMLElement, context: HostContext) {
  const view = await import('./view.tsx');
  context.signal.throwIfAborted();
  return view.mountFiles(target, context);
}

/** 发布包装与本地装载器均从唯一 manifest 传入身份，不在源码维护第二份版本。 */
export default function createFilesPlugin(
  identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>,
): WebPlugin {
if (identity.id !== FILES_PLUGIN_ID) throw new Error('文件插件清单身份与稳定工作区命名空间不一致');
return {
  ...identity,
  panels: [],
  async activate(context) {
    const ui = context.ui;
    if (!ui) throw new Error('文件插件需要支持公开工作区的宿主');
    ui.register({
      workspaces: [{
        id: FILES_WORKSPACE_ID, title: '文件工作区',
        defaultLayout: {
          version: 1, root: { kind: 'view', instanceId: FILES_INSTANCE_ID },
          floating: [], overlays: [],
        },
      }],
      pages: [{
        id: 'deviceforge_files.page', title: '文件', route: '/files',
        workspaceId: FILES_WORKSPACE_ID,
        navigation: { group: '工作台', order: 20, icon: 'folder', hidden: true, description: '浏览、预览与下载服务器产物' },
      }],
      views: [{
        id: FILES_VIEW_ID, title: '文件浏览器', provides: ['files.browser'], mount,
      }],
    });
    if (references(ui.readLayout(FILES_WORKSPACE_ID), FILES_INSTANCE_ID)) {
      ui.open({
        instanceId: FILES_INSTANCE_ID, workspaceId: FILES_WORKSPACE_ID,
        provider: { pluginId: FILES_PLUGIN_ID, viewId: FILES_VIEW_ID },
      }, context.signal);
    }
    context.onDispose(registerFilesTools(context));
  },
};
}
