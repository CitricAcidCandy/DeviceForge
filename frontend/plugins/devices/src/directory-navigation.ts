import type { HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';

export const DIRECTORY_NAVIGATION_EVENT = 'deviceforge_devices.directory.navigation';
interface DirectoryUiState { readonly open: boolean; readonly query: string; readonly source: string }
const keyOf = (instanceId: string) => `deviceforge_devices.directory-ui.${instanceId}`;
export function readDirectoryUi(context: HostContext, instanceId: string): DirectoryUiState {
  const value = context.extensions?.getState(keyOf(instanceId));
  return {
    open: !!value && typeof value === 'object' && !Array.isArray(value) && value.open === true,
    query: value && typeof value === 'object' && !Array.isArray(value) && typeof value.query === 'string' ? value.query : '',
    source: value && typeof value === 'object' && !Array.isArray(value) && typeof value.source === 'string' ? value.source : 'all',
  };
}
/** 仅保留本插件的目录展示草稿，目标换代不把选择页强行退回舞台。 */
export function updateDirectoryUi(context: HostContext, instanceId: string, change: Partial<DirectoryUiState>): void {
  if (!context.signal.aborted) context.extensions?.setState(keyOf(instanceId), { ...readDirectoryUi(context, instanceId), ...change });
}
export function requestDirectoryNavigation(context: HostContext, instance: WorkspaceViewContext | undefined, action: 'close' | 'connect'): void {
  if (!instance || context.signal.aborted || instance.signal.aborted) return;
  const current = instance.snapshot();
  context.extensions?.emitEvent(DIRECTORY_NAVIGATION_EVENT, { instanceId: current.instanceId, generation: current.generation, action });
}
