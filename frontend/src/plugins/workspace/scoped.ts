import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose } from '../../plugin-sdk/models.ts';
import type { UiAccess, WorkspacePageUpdate } from '../../plugin-sdk/workspace.ts';
import { mountWorkspaceResource } from '../workspace-rendering.ts';

/** 子功能与挂载共享同一注册表，只缩短资源所属期，不创建另一套管理器。 */
export function scopedWorkspaceAccess(upstream: UiAccess, signal: AbortSignal, track: (dispose: Dispose) => Dispose): UiAccess;
export function scopedWorkspaceAccess(upstream: UiAccess | undefined, signal: AbortSignal, track: (dispose: Dispose) => Dispose): UiAccess | undefined;
export function scopedWorkspaceAccess(upstream: UiAccess | undefined, signal: AbortSignal, track: (dispose: Dispose) => Dispose): UiAccess | undefined {
  if (!upstream) return undefined;
  const current = () => {
    if (signal.aborted) throw new HostError('cancelled', 'workspace_scope_revoked', '工作区所属作用域已撤销');
  };
  const mount = upstream.mount;
  const updatePage = upstream.updatePage;
  return Object.freeze<UiAccess>({
    ...(mount ? {
      mount(instanceId: string, target: HTMLElement, caller?: AbortSignal) {
        current();
        return mountWorkspaceResource((running) => mount(instanceId, target, running),
          caller ? AbortSignal.any([caller, signal]) : signal, track);
      },
    } : {}),
    ...(updatePage ? {
      updatePage(pageId: string, changes: WorkspacePageUpdate) {
        current(); updatePage.call(upstream, pageId, changes);
      },
    } : {}),
    register(value) { current(); return track(upstream.register(value)); },
    catalog() { current(); return upstream.catalog(); },
    snapshot() { current(); return upstream.snapshot(); },
    subscribe(listener) {
      current();
      return track(upstream.subscribe(() => { if (!signal.aborted) listener(); }));
    },
    open(input, caller) {
      current();
      return upstream.open(input, caller ? AbortSignal.any([caller, signal]) : signal);
    },
    close(instanceId) { current(); upstream.close(instanceId); },
    setTarget(instanceId, target) { current(); return upstream.setTarget(instanceId, target); },
    setVisible(instanceId, visible) { current(); return upstream.setVisible(instanceId, visible); },
    selectProvider(instanceId, provider) { current(); return upstream.selectProvider(instanceId, provider); },
    readLayout(workspaceId) { current(); return upstream.readLayout(workspaceId); },
    writeLayout(workspaceId, layout) { current(); upstream.writeLayout(workspaceId, layout); },
  });
}
