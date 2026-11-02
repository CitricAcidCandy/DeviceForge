import type { Dispose, JsonValue } from './models.ts';
import type { HostContext } from './index.ts';

/** 提供者身份与实例身份分开，同一视图可以打开多个实例。 */
export interface WorkspaceViewRef {
  readonly pluginId: string;
  readonly viewId: string;
}
export interface WorkspaceInstanceInput {
  readonly instanceId: string;
  readonly workspaceId: string;
  readonly provider: WorkspaceViewRef | null;
  readonly target?: JsonValue;
  readonly visible?: boolean;
}
export interface WorkspaceInstance {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly workspaceId: string;
  readonly provider: WorkspaceViewRef | null;
  readonly target: JsonValue;
  readonly visible: boolean;
  readonly generation: number;
  readonly providerGeneration: number | null;
  readonly state: 'ready' | 'missing' | 'unselected';
  readonly reason: 'provider_missing' | 'owner_inactive' | 'provider_unselected' | null;
}
export interface WorkspaceViewContext {
  readonly signal: AbortSignal;
  snapshot(): WorkspaceInstance;
  subscribeVisibility(listener: (visible: boolean) => void): Dispose;
}
/** 挂载函数只在本地使用，不进入目录或持久布局。 */
export type WorkspaceMount = (
  target: HTMLElement,
  context: HostContext,
  instance: WorkspaceViewContext,
) => Promise<Dispose>;
export interface WorkspaceNavigation {
  readonly group?: string;
  readonly order?: number;
  readonly icon?: string;
  readonly hidden?: boolean;
  readonly description?: string;
}
export interface WorkspacePageDefinition {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly workspaceId?: string;
  readonly mount?: WorkspaceMount;
  readonly navigation?: WorkspaceNavigation;
  readonly operations?: readonly string[];
  readonly taskPolicy?: 'listed' | 'all';
}
export type WorkspacePageUpdate = Partial<Pick<WorkspacePageDefinition,
  'title' | 'navigation' | 'operations' | 'taskPolicy'>>;
export interface WorkspaceDefinition {
  readonly id: string;
  readonly title: string;
  readonly defaultLayout?: WorkspaceLayout;
}
export interface WorkspaceViewDefinition {
  readonly id: string;
  readonly title: string;
  readonly provides?: readonly string[];
  readonly mount: WorkspaceMount;
}
export interface WorkspaceContributions {
  readonly pages?: readonly WorkspacePageDefinition[];
  readonly workspaces?: readonly WorkspaceDefinition[];
  readonly views?: readonly WorkspaceViewDefinition[];
}

export interface WorkspaceViewNode {
  readonly kind: 'view';
  readonly instanceId: string;
}
export interface WorkspaceSplitNode {
  readonly kind: 'split';
  readonly direction: 'horizontal' | 'vertical';
  readonly weights: readonly number[];
  readonly children: readonly WorkspaceLayoutNode[];
}
export interface WorkspaceTabsNode {
  readonly kind: 'tabs';
  readonly active: string | null;
  readonly items: readonly {
    readonly id: string;
    readonly title?: string;
    readonly node: WorkspaceLayoutNode;
  }[];
}
export interface WorkspaceCustomNode {
  readonly kind: 'custom';
  readonly provider: WorkspaceViewRef;
  readonly data: JsonValue;
  readonly children?: readonly WorkspaceLayoutNode[];
}
export type WorkspaceLayoutNode =
  | WorkspaceViewNode | WorkspaceSplitNode | WorkspaceTabsNode | WorkspaceCustomNode;
export interface WorkspaceFloatingView {
  readonly instanceId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly z: number;
}
export interface WorkspaceOverlayView extends WorkspaceFloatingView {
  readonly relativeTo?: string;
}
export interface WorkspaceLayout {
  readonly version: 1;
  readonly root: WorkspaceLayoutNode | null;
  readonly floating: readonly WorkspaceFloatingView[];
  readonly overlays: readonly WorkspaceOverlayView[];
}

export interface WorkspaceDefinitionInfo {
  readonly id: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly title: string;
}
export interface WorkspacePageInfo extends WorkspaceDefinitionInfo {
  readonly route: string;
  readonly workspaceId: string | null;
  /** 带挂载函数的页面派生同标识视图，外壳统一通过公开 mount 渲染。 */
  readonly viewId?: string | null;
  readonly navigation?: WorkspaceNavigation;
  readonly operations?: readonly string[];
  readonly taskPolicy?: 'listed' | 'all';
}
export interface WorkspaceViewInfo extends WorkspaceDefinitionInfo {
  readonly provides: readonly string[];
}
export interface WorkspaceCatalog {
  readonly pages: readonly WorkspacePageInfo[];
  readonly workspaces: readonly WorkspaceDefinitionInfo[];
  readonly views: readonly WorkspaceViewInfo[];
}
export interface WorkspaceSnapshot {
  readonly revision: number;
  readonly catalog: WorkspaceCatalog;
  readonly instances: readonly WorkspaceInstance[];
  readonly layouts: readonly { readonly workspaceId: string; readonly layout: WorkspaceLayout }[];
}
/** 可保存的数据没有运行代次、信号或挂载函数；恢复不执行任何业务动作。 */
export interface WorkspaceSavedState {
  readonly version: 1;
  readonly instances: readonly (WorkspaceInstanceInput & { readonly pluginId: string })[];
  readonly layouts: readonly { readonly workspaceId: string; readonly layout: WorkspaceLayout }[];
}
export interface UiAccess {
  /** 渲染宿主可挂载已选择提供者的实例；释放句柄仅属于本次挂载，不影响后来新代。 */
  readonly mount?: (instanceId: string, target: HTMLElement, signal: AbortSignal) => Promise<Dispose>;
  register(contributions: WorkspaceContributions): Dispose;
  /** 原位更新当前作用域登记的页面元数据，不变更路由、挂载或运行代次；旧宿主可省略。 */
  readonly updatePage?: (pageId: string, changes: WorkspacePageUpdate) => void;
  catalog(): WorkspaceCatalog;
  snapshot(): WorkspaceSnapshot;
  subscribe(listener: () => void): Dispose;
  open(input: WorkspaceInstanceInput, signal?: AbortSignal): WorkspaceInstance;
  close(instanceId: string): void;
  setTarget(instanceId: string, target: JsonValue): WorkspaceInstance;
  setVisible(instanceId: string, visible: boolean): WorkspaceInstance;
  selectProvider(instanceId: string, provider: WorkspaceViewRef | null): WorkspaceInstance;
  readLayout(workspaceId: string): WorkspaceLayout | null;
  writeLayout(workspaceId: string, layout: WorkspaceLayout): void;
}
