import { hostUi } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { DEVICE_WORKBENCH_PANE_EVENT, sameDevice, targetReference } from './contracts.ts';
import { createWorkbenchChildren } from './workbench-children.ts';
import { WorkbenchChild } from './workbench-child.tsx';
import { WorkbenchDialog } from './workbench-dialog.tsx';
import { WorkbenchTools } from './workbench-tools.tsx';
import { useDeviceSnapshot } from './workspace-hooks.ts';

function ToolIcon({ path }: { readonly path: string }) {
  return <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={path} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function DeviceWorkbench({ context, instance, children }: {
  readonly context: HostContext;
  readonly instance: WorkspaceViewContext;
  readonly children: ReturnType<typeof createWorkbenchChildren>;
}) {
  const ui = hostUi();
  const { useEffect, useState } = ui.React;
  const [panel, setPanel] = useState<'directory' | 'connection' | 'capabilities' | null>(null);
  const directoryOpen = panel === 'directory';
  const devices = useDeviceSnapshot(context.devices, context.signal);
  const reference = targetReference(instance.snapshot().target);
  const provider = devices.providers.find((entry) => entry.id === reference?.providerId && entry.generation === reference.generation) ?? null;
  const selected = sameDevice(devices.selected?.reference ?? null, reference) && sameDevice(devices.selection, reference) ? devices.selected : null;
  const count = devices.directories.reduce((total, directory) => total + directory.devices.length, 0);
  useEffect(() => {
    const release = instance.subscribeVisibility((visible) => {
      if (!visible) setPanel(null);
    });
    return () => { void release(); };
  }, [instance]);
  useEffect(() => {
    children.setDirectoryVisible(directoryOpen);
  }, [children, directoryOpen]);
  const showPane = context.extensions ? (pane: 'params' | 'apps') => {
    context.extensions?.emitEvent(DEVICE_WORKBENCH_PANE_EVENT, { screenInstanceId: children.screenInstanceId, pane });
    setPanel(null);
  } : undefined;
  return <section data-product-page="devices" aria-label="设备工作台" className="@container/device relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#F5F6FB]">
    <nav aria-label="设备工具" className="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-px rounded-[10px] border border-[#E6EAF3] bg-white p-1 shadow-[0_14px_32px_-26px_#1722347a] @max-[1024px]/device:top-3 @max-[1024px]/device:translate-y-0">
      <button type="button" title="设备目录" aria-label="设备目录" aria-expanded={directoryOpen} onClick={() => setPanel('directory')} className="flex size-[30px] items-center justify-center rounded-[7px] text-[#8790A2] hover:bg-[#F0EBFF] hover:text-[#6C4CF5]">
        <ToolIcon path="M8 2h8v20H8z M11 18h2" />
      </button>
      <a href="#/performance" title="性能与调用栈" aria-label="性能与调用栈" className="flex size-[30px] items-center justify-center rounded-[7px] text-[#8790A2] hover:bg-[#F0EBFF] hover:text-[#6C4CF5]"><ToolIcon path="M3 15a9 9 0 1 1 18 0 M12 13l5-5 M5 17h14" /></a>
      <a href="#/terminal" title="终端" aria-label="终端" className="flex size-[30px] items-center justify-center rounded-[7px] text-[#8790A2] hover:bg-[#F0EBFF] hover:text-[#6C4CF5]"><ToolIcon path="m4 5 6 7-6 7 M13 19h7" /></a>
      <button type="button" title={selected && provider ? '能力与原始结果' : '先选择设备'} aria-label="能力与原始结果" aria-expanded={panel === 'capabilities'} disabled={!selected || !provider} onClick={() => setPanel('capabilities')} className="flex size-[30px] items-center justify-center rounded-[7px] text-[#8790A2] hover:bg-[#F0EBFF] hover:text-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-40"><ToolIcon path="m8 5-6 7 6 7 M16 5l6 7-6 7" /></button>
      <span className="my-1 h-px w-4 bg-[#E6EAF3]" aria-hidden="true" />
      <button type="button" title="连接设备" aria-label="连接设备" aria-expanded={panel === 'connection'} onClick={() => setPanel('connection')} className="flex size-[30px] items-center justify-center rounded-[7px] border border-dashed border-[#E6EAF3] text-[#8790A2] hover:bg-[#F0EBFF] hover:text-[#6C4CF5]"><ToolIcon path="M12 5v14 M5 12h14" /></button>
    </nav>
    {reference ? <WorkbenchChild instanceId={children.screenInstanceId} context={context} ui={children.ui} /> : <div className="relative mx-16 my-3.5 flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-[#E6EAF3] bg-white @max-[36rem]/device:mx-3 @max-[36rem]/device:ml-16">
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 size-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,#6C4CF51c_0%,transparent_70%)]" />
      <div className="relative flex max-h-full w-full max-w-[460px] flex-col items-center gap-5 overflow-y-auto px-4 py-4 text-center">
        <div aria-hidden="true" className="flex aspect-[150/320] h-[min(320px,45dvh)] shrink-0 flex-col rounded-[26px] border border-dashed border-[#C8D0E2] bg-white p-1.5">
          <div className="relative flex min-h-0 flex-1 items-center justify-center rounded-[21px] bg-[#F5F6FB] text-[#BAC0CC]"><ToolIcon path="M8 2h8v20H8z M11 18h2" /><span className="absolute bottom-2 left-1/2 h-[3px] w-[52px] -translate-x-1/2 rounded-full bg-[#C8D0E2]" /></div>
        </div>
        <div className="space-y-1.5"><h1 className="text-lg font-semibold text-[#222631]">{!devices.providers.length ? '还没有可用的设备提供者' : !count ? '还没有发现设备' : '还没有设备进入工作台'}</h1>
          <p className="text-xs leading-6 text-[#596479]">{!devices.providers.length ? '在市场页「已安装」里启用设备提供者，再回到这里发现设备' : !count ? '连接一台设备，或在设备目录里重新发现' : `目录里已有 ${count} 台设备，选一台开始投屏`}</p></div>
        <div className="flex flex-wrap justify-center gap-2">{devices.providers.length > 0 ? <button type="button" onClick={() => setPanel('directory')} className="rounded-lg bg-[#6C4CF5] px-4 py-2 text-xs text-white">打开设备目录</button>
          : <a href="#/marketplace" className="rounded-lg bg-[#6C4CF5] px-4 py-2 text-xs text-white">去市场页启用</a>}
          <button type="button" onClick={() => setPanel('connection')} className="rounded-lg border border-[#E6EAF3] bg-white px-4 py-2 text-xs text-[#596479]">连接设备</button></div>
      </div>
    </div>}
    <WorkbenchDialog open={directoryOpen} onOpenChange={(open) => setPanel(open ? 'directory' : null)} title="设备目录" description="选择设备、读取目录或显式发现；不会自动启动投屏和采集。" actions={<button type="button" onClick={() => setPanel('connection')} className="rounded-md border border-[#E6EAF3] px-2 py-1 text-xs text-[#6C4CF5]">连接设备</button>}>
      <div className="h-[min(580px,65dvh)] min-h-0"><WorkbenchChild instanceId={children.directoryInstanceId} context={context} ui={children.ui} /></div>
    </WorkbenchDialog>
    <WorkbenchDialog open={panel === 'connection'} onOpenChange={(open) => setPanel(open ? 'connection' : null)} title="连接与断开设备" description="通过当前运行的设备提供者连接地址，任务完成后刷新观测。">
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
