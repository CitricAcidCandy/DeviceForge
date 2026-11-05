import { hostUi } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { DEVICE_WORKBENCH_PANE_EVENT, sameDevice, targetReference } from './contracts.ts';
import { createWorkbenchChildren } from './workbench-children.ts';
import { WorkbenchChild } from './workbench-child.tsx';
import { WorkbenchDialog } from './workbench-dialog.tsx';
import { WorkbenchTools } from './workbench-tools.tsx';
import { useDeviceSnapshot, useDirectoryObservation } from './workspace-hooks.ts';
import { Code2, Gauge, Plus, Smartphone, Terminal } from './icons.tsx';
import { DIRECTORY_NAVIGATION_EVENT, readDirectoryUi, updateDirectoryUi } from './directory-navigation.ts';

export function DeviceWorkbench({ context, instance, children }: {
  readonly context: HostContext;
  readonly instance: WorkspaceViewContext;
  readonly children: ReturnType<typeof createWorkbenchChildren>;
}) {
  const ui = hostUi();
  const { useEffect, useState } = ui.React;
  const [panel, setPanelValue] = useState<'directory' | 'capabilities' | null>(() =>
    readDirectoryUi(context, children.directoryInstanceId).open ? 'directory' : null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const setPanel = (next: 'directory' | 'capabilities' | null) => {
    updateDirectoryUi(context, children.directoryInstanceId, { open: next === 'directory' });
    setPanelValue(next);
  };
  const directoryOpen = panel === 'directory';
  const devices = useDeviceSnapshot(context.devices, context.signal);
  const observation = useDirectoryObservation(context);
  const unavailable = !context.devices || observation.status === 'unavailable';
  const confirmed = observation.status === 'confirmed';
  const reference = targetReference(instance.snapshot().target);
  const provider = devices.providers.find((entry) => entry.id === reference?.providerId && entry.generation === reference.generation) ?? null;
  const selected = sameDevice(devices.selected?.reference ?? null, reference) && sameDevice(devices.selection, reference) ? devices.selected : null;
  const count = devices.directories.reduce((total, directory) => total + directory.devices.length, 0);
  const title = unavailable ? '当前宿主未提供设备目录'
    : observation.status === 'pending' ? '正在读取设备目录'
    : observation.status === 'failed' ? '设备目录读取失败'
    : !confirmed ? '设备目录尚未确认'
    : !devices.providers.length ? '还没有可用的设备提供者'
    : !count ? '还没有发现设备' : '还没有设备进入工作台';
  const description = unavailable ? '请核对当前宿主与设备插件的版本。'
    : observation.status === 'pending' ? '正在读取提供者与已有设备，完成后可选择设备。'
    : observation.status === 'failed' ? observation.message ?? '可打开设备目录，重新读取并核对当前状态。'
    : !confirmed ? '可打开设备目录，读取当前提供者与已有设备。'
    : !devices.providers.length ? '在市场页「已安装」里启用设备提供者，再回到这里发现设备'
    : !count ? '连接一台设备，或在设备目录里重新发现' : `目录里已有 ${count} 台设备，选一台开始投屏`;
  useEffect(() => {
    let disposed = false;
    const synchronize = (visible: boolean) => {
      if (disposed || context.signal.aborted || instance.signal.aborted) return;
      if (!visible) { setPanel(null); setConnectionOpen(false); }
    };
    const release = instance.subscribeVisibility(synchronize);
    try { synchronize(instance.snapshot().visible); }
    catch (error) { disposed = true; void release(); throw error; }
    return () => { disposed = true; void release(); };
  }, [context, instance]);
  useEffect(() => {
    children.setDirectoryVisible(directoryOpen);
  }, [children, directoryOpen]);
  useEffect(() => {
    const release = context.extensions?.subscribeEvent(DIRECTORY_NAVIGATION_EVENT, (event) => {
      const value = event.data;
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          value.instanceId !== children.directoryInstanceId || context.signal.aborted || instance.signal.aborted) return;
      const current = children.ui.snapshot().instances.find((entry) => entry.instanceId === children.directoryInstanceId);
      if (!current?.visible || current.generation !== value.generation) return;
      if (value.action === 'close') setPanel(null);
      else if (value.action === 'connect') setConnectionOpen(true);
    });
    return () => { void release?.(); };
  }, [context, instance, children]);
  const showPane = context.extensions ? (pane: 'params' | 'apps') => {
    context.extensions?.emitEvent(DEVICE_WORKBENCH_PANE_EVENT, { screenInstanceId: children.screenInstanceId, pane });
    setPanel(null);
  } : undefined;
  return <section data-product-page="devices" aria-label="设备工作台" className="@container/device relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#F5F6FB]">
    <div className={directoryOpen ? 'hidden' : 'relative flex min-h-0 min-w-0 flex-1 flex-col'} aria-hidden={directoryOpen}>
    <nav aria-label="设备工具" className="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-px rounded-[10px] border border-[#E6EAF3] bg-white p-1 shadow-[0_14px_32px_-26px_#1722347a] @max-[1024px]/device:top-3 @max-[1024px]/device:translate-y-0">
      <button type="button" title="设备目录" aria-label="设备目录" aria-expanded={directoryOpen} onClick={() => setPanel('directory')} className="flex size-[30px] items-center justify-center rounded-[7px] text-faint hover:bg-surface-hover hover:text-ink focus-visible:outline-primary">
        <Smartphone className="size-[15px]" />
      </button>
      <a href="#/performance" title="性能与调用栈" aria-label="性能与调用栈" className="flex size-[30px] items-center justify-center rounded-[7px] text-faint hover:bg-surface-hover hover:text-ink focus-visible:outline-primary"><Gauge className="size-[15px]" /></a>
      <a href="#/terminal" title="终端" aria-label="终端" className="flex size-[30px] items-center justify-center rounded-[7px] text-faint hover:bg-surface-hover hover:text-ink focus-visible:outline-primary"><Terminal className="size-[15px]" /></a>
      <button type="button" title={selected && provider ? '能力与原始结果' : '先选择设备'} aria-label="能力与原始结果" aria-expanded={panel === 'capabilities'} disabled={!selected || !provider} onClick={() => setPanel('capabilities')} className="flex size-[30px] items-center justify-center rounded-[7px] text-faint hover:bg-surface-hover hover:text-ink focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"><Code2 className="size-[15px]" /></button>
      <span className="my-1 h-px w-4 bg-[#E6EAF3]" aria-hidden="true" />
      <span title="插件工具插槽：由插件追加到此位置" aria-label="插件工具插槽" className="flex size-[30px] items-center justify-center rounded-[7px] border border-dashed border-hairline-strong text-faint"><Plus className="size-[15px]" /></span>
    </nav>
    {reference ? <WorkbenchChild instanceId={children.screenInstanceId} context={context} ui={children.ui} /> : <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden py-3.5 pl-16 pr-3 @min-[36rem]/device:pr-16">
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 size-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,#6C4CF51c_0%,transparent_70%)]" />
      <div className="relative flex max-h-full w-full max-w-[460px] flex-col items-center gap-5 overflow-y-auto px-4 py-4 text-center">
        <div aria-hidden="true" className="flex aspect-[150/320] h-[min(320px,45dvh)] shrink-0 flex-col rounded-[26px] border border-dashed border-[#C8D0E2] bg-white p-1.5">
          <div className="relative flex min-h-0 flex-1 items-center justify-center rounded-[21px] bg-[#F5F6FB] text-[#BAC0CC]"><Smartphone className="size-[34px]" strokeWidth={1.3} /><span className="absolute bottom-2 left-1/2 h-[3px] w-[52px] -translate-x-1/2 rounded-full bg-[#C8D0E2]" /></div>
        </div>
        <div role={observation.status === 'failed' ? 'alert' : 'status'} className="min-w-0 space-y-1.5 wrap-anywhere"><h1 className="text-lg font-semibold text-[#222631]">{title}</h1>
          <p className="text-xs leading-6 text-[#596479]">{description}</p>
          {observation.status === 'failed' && observation.logId && <p className="select-all font-mono text-[10px] text-faint">日志 ID：{observation.logId}</p>}</div>
        <div className="flex flex-wrap justify-center gap-2">{!unavailable && (!confirmed || devices.providers.length > 0) ? <button type="button" onClick={() => setPanel('directory')} className="rounded-lg bg-[#6C4CF5] px-4 py-2 text-xs text-white">打开设备目录</button>
          : confirmed && <a href="#/marketplace" className="rounded-lg bg-[#6C4CF5] px-4 py-2 text-xs text-white">去市场页启用</a>}
          <button type="button" disabled={unavailable} onClick={() => setConnectionOpen(true)} className="rounded-lg border border-[#E6EAF3] bg-white px-4 py-2 text-xs text-[#596479] disabled:cursor-not-allowed disabled:opacity-50">连接设备</button></div>
      </div>
    </div>}
    </div>
    {directoryOpen && <div className="flex min-h-0 min-w-0 flex-1"><WorkbenchChild instanceId={children.directoryInstanceId} context={context} ui={children.ui} /></div>}
    <WorkbenchDialog open={connectionOpen} onOpenChange={setConnectionOpen} title="连接与断开设备" description="通过当前运行的设备提供者连接地址，任务完成后刷新观测。">
      <WorkbenchTools kind="connection" context={context} reference={reference} provider={provider} />
    </WorkbenchDialog>
    <WorkbenchDialog open={panel === 'capabilities'} onOpenChange={(open) => setPanel(open ? 'capabilities' : null)} title={selected?.model ?? reference?.localId ?? '设备能力'} description="按提供者声明调用实际能力；写入操作提交后不可回滚。" side="right">
      <WorkbenchTools kind="capabilities" context={context} reference={reference} provider={provider} onShowPane={showPane} />
    </WorkbenchDialog>
  </section>;
}

export function mountWorkbench(
  target: HTMLElement, context: HostContext, instance: WorkspaceViewContext,
  releaseChildren: (owned: readonly { readonly id: string; readonly generation: number }[]) => void,
): Dispose {
  const children = createWorkbenchChildren(context, instance);
  let release: Dispose;
  try { release = hostUi().mountReact(target, <DeviceWorkbench context={context} instance={instance} children={children} />); }
  catch (error) { children.dispose(); releaseChildren(children.owned()); throw error; }
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    children.dispose();
    const failures: unknown[] = [];
    // 先撤销嵌套挂载，再卸载父 React 根，避免在父提交阶段同步卸载另一根。
    try { releaseChildren(children.owned()); } catch (error) { failures.push(error); }
    try { await release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, '设备工作台资源回收未确认');
  };
}
