import { useState, useSyncExternalStore } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext } from '@deviceforge/plugin-sdk';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@deviceforge/business-kit/react';
import { deviceIdentity } from './contracts.ts';
import { createDeviceHeader } from './header-model.ts';
import type { DeviceHeaderModel } from './header-model.ts';
import { DeviceHeaderPreview, DeviceHeaderRow, HeaderBadge, HeaderIcon, headerRows, stateDot } from './header-presentation.tsx';
import type { HeaderPreview, HeaderRow } from './header-presentation.tsx';

/** 还原原顶栏设备胶囊；设备选择和发现只通过所属插件的公开模型。 */
export function DeviceHeader({ model }: { readonly model: DeviceHeaderModel }) {
  const { Button } = hostUi();
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<HeaderPreview | null>(null);
  const rows = headerRows(state.devices);
  const selectedKey = deviceIdentity(state.devices.selection);
  const current = rows.find((row) => deviceIdentity(row.device.reference) === selectedKey) ?? null;
  const online = rows.filter((row) => row.device.state === 'online');
  const rest = rows.filter((row) => row.device.state !== 'online');
  const choose = (key: string) => { model.select(key); setPreview(null); };
  function showPreview(row: HeaderRow, element: HTMLElement) {
    const document = element.ownerDocument, window = document.defaultView;
    if (!window || window.innerWidth < 900) return;
    const box = element.getBoundingClientRect();
    const left = box.right + 242 > window.innerWidth - 12 ? box.left - 242 : box.right + 10;
    const top = Math.max(12, Math.min(box.top - 6, window.innerHeight - 220));
    setPreview({ row, document, left: Math.max(12, left), top });
  }
  const renderRow = (row: HeaderRow) => <DeviceHeaderRow key={deviceIdentity(row.device.reference)}
    row={row} checked={deviceIdentity(row.device.reference) === selectedKey}
    preview={showPreview} clear={() => setPreview(null)} />;
  return <div data-slot="device-context" className="inline-flex h-full min-w-0 max-w-full items-center">
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPreview(null); }}>
      <DropdownMenuTrigger asChild><button type="button" aria-label="选择当前设备"
        className={`group inline-flex h-[26px] min-w-0 max-w-full items-center gap-1.5 rounded-full border bg-surface-sunken px-2.5 text-[12.5px] text-body outline-none hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/55 data-[state=open]:border-hairline-strong data-[state=open]:bg-card ${current ? 'border-transparent' : 'border-dashed border-hairline-strong font-medium'}`}>
        {current && <HeaderBadge row={current} small />}
        <span className="min-w-0 truncate font-semibold text-ink">{current ? current.device.model ?? current.device.reference.localId : '选择设备'}</span>
        {current && <span aria-hidden="true" className={`size-[5px] shrink-0 rounded-full ${stateDot(current.device.state)}`} />}
        <HeaderIcon name="down" className="size-2.5 shrink-0 text-faint transition-transform group-data-[state=open]:rotate-180" />
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12}
        className="flex w-[372px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[14px] border border-hairline bg-card p-0 shadow-pop">
        <div className="flex h-[46px] shrink-0 items-center justify-between gap-3 border-b border-hairline px-4">
          <span className="text-[11px] font-semibold tracking-[0.02em] text-faint">切换设备</span>
          <span className="font-mono text-[11px] text-ghost">{rows.length} 台{rows.length > 0 ? ` · ${online.length} 在线` : ''}</span>
        </div>
        {rows.length === 0 ? <div className="flex flex-col items-center gap-2 px-6 py-5 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-surface-sunken text-faint"><HeaderIcon name="phone" className="size-[18px]" /></span>
          <strong className="text-[13px] font-semibold text-ink">尚未发现设备</strong>
          <p className="max-w-[240px] text-[11.5px] leading-relaxed text-faint">连接设备后点下方「发现设备」，或直接在设备页输入连接地址。</p>
          <Button size="sm" asChild className="mt-1 min-w-28"><a href="#/devices" onClick={() => setOpen(false)}>去设备页</a></Button>
        </div> : <div className="min-h-0 flex-1 overflow-y-auto py-1" onScroll={() => setPreview(null)}>
          <DropdownMenuRadioGroup value={selectedKey} onValueChange={choose}>
            {online.length > 0 && <DropdownMenuGroup><DropdownMenuLabel className="px-4 pb-1 pt-1.5 text-[11px] font-medium text-ghost">在线</DropdownMenuLabel>{online.map(renderRow)}</DropdownMenuGroup>}
            {rest.length > 0 && <DropdownMenuGroup><DropdownMenuSeparator className="mx-4 my-1.5 h-px bg-hairline" />
              <DropdownMenuLabel className="px-4 pb-1 pt-1.5 text-[11px] font-medium text-ghost">离线与待授权</DropdownMenuLabel>{rest.map(renderRow)}</DropdownMenuGroup>}
          </DropdownMenuRadioGroup>
        </div>}
        {state.feedback && <div role={state.feedback.outcome === 'failed' || state.feedback.outcome === 'partial' ? 'alert' : 'status'}
          className="max-h-36 shrink-0 overflow-auto border-t border-hairline px-4 py-2 text-[11px] leading-5 text-body">
          <p>{state.feedback.message}</p>
          {state.feedback.logId && <p className="select-all break-all font-mono text-[10px] text-faint">日志 {state.feedback.logId}</p>}
          {state.feedback.details.map((failure) => <p key={failure.provider} className="break-words text-warning">{failure.provider}：{failure.message}{failure.logId ? ` · ${failure.logId}` : ''}</p>)}
        </div>}
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-t border-hairline p-1">
          <DropdownMenuItem disabled={state.pending} className="gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-primary data-[disabled]:text-ghost"
            onSelect={(event) => { event.preventDefault(); void model.discover(); }}>
            <HeaderIcon name="refresh" className={`size-3 ${state.pending ? 'animate-spin' : ''}`} />发现设备
          </DropdownMenuItem>
          {state.pending && <DropdownMenuItem className="rounded-md px-2.5 py-1.5 text-[11.5px] text-faint" onSelect={(event) => { event.preventDefault(); model.cancel(); }}>取消等待</DropdownMenuItem>}
          {current && <DropdownMenuItem className="rounded-md px-2.5 py-1.5 text-[11.5px] text-faint" onSelect={() => { model.select(null); }}>清除选择</DropdownMenuItem>}
          <DropdownMenuItem asChild className="ml-auto gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-primary"><a href="#/devices" onClick={() => setOpen(false)}>在设备页里选择<HeaderIcon name="right" /></a></DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
    {open && preview && rows.some((row) => deviceIdentity(row.device.reference) === deviceIdentity(preview.row.device.reference)) && <DeviceHeaderPreview preview={preview} />}
  </div>;
}

export function mountDeviceHeader(target: HTMLElement, context: HostContext): Dispose {
  const model = createDeviceHeader(context);
  const releaseModel = context.onDispose(model.dispose);
  let releaseUi: Dispose;
  try { releaseUi = hostUi().mountReact(target, <DeviceHeader model={model} />); }
  catch (error) { void releaseModel(); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await releaseModel(); }
    finally { await releaseUi(); }
  };
}
