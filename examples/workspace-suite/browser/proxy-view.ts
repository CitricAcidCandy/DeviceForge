import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, UiAccess, WorkspaceViewContext, WorkspaceViewInfo } from '@deviceforge/plugin-sdk';

let sequence = 0;

export function resolveFilesView(ui: Pick<UiAccess, 'catalog'>, pluginId: string): WorkspaceViewInfo {
  const candidates = ui.catalog().views.filter((view) => view.pluginId !== pluginId &&
    view.provides.includes('files.browser'));
  const provider = candidates.length === 1 ? candidates[0] : null;
  if (!provider) throw new HostError('protocol', 'example_files_view_missing',
    '文件视图缺失或存在多个提供者，请先核对公开视图目录');
  return provider;
}

/** 复用目录中唯一的公开文件视图，不创建新界面，也不猜测已有实例。 */
export async function mountProxy(target: HTMLElement, context: HostContext,
  instance: WorkspaceViewContext, pluginId: string): Promise<Dispose> {
  const ui = context.ui;
  if (!ui?.mount) throw new HostError('protocol', 'example_renderer_missing', '宿主尚未提供公开视图挂载能力');
  const render = ui.mount;
  return mountFileDelegate(context, instance, pluginId, (id, signal) => render(id, target, signal));
}

/** 生命周期只依赖公开端口，DOM 由上面的薄适配传入。 */
export async function mountFileDelegate(context: HostContext, instance: WorkspaceViewContext,
  pluginId: string, render: (instanceId: string, signal: AbortSignal) => Promise<Dispose>): Promise<Dispose> {
  const ui = context.ui, initial = instance.snapshot();
  if (!ui) throw new HostError('protocol', 'example_workspace_missing', '宿主没有公开工作区入口');
  const provider = resolveFilesView(ui, pluginId);
  const signal = AbortSignal.any([context.signal, instance.signal]);
  signal.throwIfAborted();
  const delegateId = `${pluginId}.delegate.${++sequence}`;
  ui.open({
    instanceId: delegateId, workspaceId: initial.workspaceId,
    provider: { pluginId: provider.pluginId, viewId: provider.id },
    target: initial.target, visible: initial.visible,
  }, signal);
  let released = false, releaseView: Dispose | null = null, cleanup: Promise<void> | null = null;
  const stopVisibility = instance.subscribeVisibility((visible) => {
    if (!released && !signal.aborted) ui.setVisible(delegateId, visible);
  });
  const dispose: Dispose = () => {
    if (cleanup) return cleanup;
    released = true;
    signal.removeEventListener('abort', aborted);
    cleanup = (async () => {
      const failures: unknown[] = [];
      try { await stopVisibility(); } catch (error) { failures.push(error); }
      try { ui.close(delegateId); } catch (error) { failures.push(error); }
      try { if (releaseView) await releaseView(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, '委托视图回收失败');
    })();
    // 取消事件没有等待通道；真实宿主仍可等待同一 Dispose 读取失败。
    void cleanup.catch(() => {});
    return cleanup;
  };
  const aborted = () => { void dispose(); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    signal.throwIfAborted();
    const result = await render(delegateId, signal);
    if (released || signal.aborted) { await result(); signal.throwIfAborted(); }
    releaseView = result;
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
