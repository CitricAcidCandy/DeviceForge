import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, WorkspaceViewContext, WorkspaceViewRef } from '@deviceforge/plugin-sdk';

export interface ShellMountObservation {
  readonly mount: 'not_observed' | 'mounting' | 'ready' | 'failed' | 'released';
  readonly mountCount: number;
  readonly releaseCount: number;
  readonly error: string | null;
}
export interface ShellDelegateOptions {
  readonly instanceId: string;
  readonly original: WorkspaceViewRef;
  readonly behavior: 'delegate' | 'fail';
  readonly signal: AbortSignal;
  readonly update: (change: (current: ShellMountObservation) => ShellMountObservation) => void;
}

/** 只委托公开外壳视图；不读取其实现，不接管业务布局或重放任务。 */
export async function mountShellDelegate(
  target: HTMLElement,
  context: HostContext,
  parent: WorkspaceViewContext,
  options: ShellDelegateOptions,
): Promise<Dispose> {
  const own = new AbortController();
  const signal = AbortSignal.any([context.signal, parent.signal, options.signal, own.signal]);
  signal.throwIfAborted();
  options.update((current) => ({ ...current, mount: 'mounting', mountCount: current.mountCount + 1 }));
  const ui = context.ui;
  let generation: number | null = null, release: Dispose | null = null, visible: Dispose | null = null;
  let disposed = false;
  const closeFailures: unknown[] = [];
  const closeOwned = () => {
    if (!ui || context.signal.aborted || generation === null) return;
    try {
      const current = ui.snapshot().instances.find((entry) => entry.instanceId === options.instanceId);
      if (current?.generation === generation) ui.close(options.instanceId);
    } catch (error) {
      // 登记所有者可先于视图信号撤销；宿主已撤资格时不再通过旧访问器关闭实例。
      const ownerRevoked = error !== null && typeof error === 'object' &&
        'kind' in error && error.kind === 'cancelled' &&
        'code' in error && error.code === 'workspace_owner_revoked';
      if (!ownerRevoked) closeFailures.push(error);
    }
  };
  // 先于open登记的所有者撤销回调关闭本代；否则撤销推进代次后无法再辨认本次实例。
  signal.addEventListener('abort', closeOwned, { once: true });
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', closeOwned);
    closeOwned();
    own.abort();
    const failures: unknown[] = [...closeFailures];
    try { await visible?.(); } catch (error) { failures.push(error); }
    try { await release?.(); } catch (error) { failures.push(error); }
    options.update((current) => ({ ...current, mount: 'released', releaseCount: current.releaseCount + 1 }));
    if (failures.length) throw new AggregateError(failures, '示例外壳委托回收未确认');
  };
  try {
    if (options.behavior === 'fail')
      throw new HostError('protocol', 'example_shell_candidate_failed', '示例外壳候选按要求失败');
    if (!ui?.mount) throw new HostError('protocol', 'example_shell_mount_missing', '当前作用域缺少公开外壳挂载能力');
    const child = ui.open({ instanceId: options.instanceId, workspaceId: 'host.shell',
      provider: options.original, visible: parent.snapshot().visible }, signal);
    generation = child.generation;
    visible = parent.subscribeVisibility((value) => {
      if (signal.aborted) return;
      const current = ui.snapshot().instances.find((entry) => entry.instanceId === options.instanceId);
      if (current?.generation === generation) ui.setVisible(options.instanceId, value);
    });
    release = await ui.mount(options.instanceId, target, signal);
    if (signal.aborted) {
      await dispose();
      throw new HostError('cancelled', 'example_shell_candidate_revoked', '示例外壳候选已撤销，不提交晚到挂载');
    }
    options.update((current) => ({ ...current, mount: 'ready' }));
    return dispose;
  } catch (error) {
    const revoked = signal.aborted;
    signal.removeEventListener('abort', closeOwned);
    if (!disposed && generation !== null) {
      try { await dispose(); } catch { /* 原挂载失败保持可见，回收失败由宿主独立诊断。 */ }
    }
    options.update((current) => ({ ...current, mount: revoked ? 'released' : 'failed',
      error: error instanceof Error ? error.message : '示例外壳挂载结果未确认' }));
    throw error;
  }
}
