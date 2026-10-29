import { FilesView } from '@deviceforge/files/view';
import type { FileBrowser } from '@deviceforge/files/model';

/** 过渡路由仅委托独立插件公开界面，正式入口由工作区注册目录提供。 */
export function FilesPage({ services }: {
  services: { readonly artifactBrowser: { readonly publicModel: FileBrowser } };
}) {
  return <FilesView browser={services.artifactBrowser.publicModel} />;
}