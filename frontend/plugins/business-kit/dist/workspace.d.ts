import type { HostContext, WorkspaceMount, WorkspaceNavigation } from '@deviceforge/plugin-sdk';
/** 只在既有布局仍引用默认实例时恢复它，不覆盖用户移除或重排的布局。 */
export declare function registerBusinessWorkspace(context: HostContext, definition: {
    readonly pluginId: string;
    readonly title: string;
    readonly route: string;
    readonly navigation: WorkspaceNavigation;
    readonly operations: readonly string[];
    readonly provides: readonly string[];
    readonly mount: WorkspaceMount;
}): void;
