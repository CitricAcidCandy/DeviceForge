import { useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { createPortal } from 'react-dom';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { DeviceSnapshot, ProvidedDevice } from '@deviceforge/plugin-sdk';
import { DropdownMenuRadioItem } from '@deviceforge/business-kit/react';
import { deviceIdentity } from './contracts.ts';

export interface HeaderRow { readonly device: ProvidedDevice; readonly platform: string; readonly observedAt: number }
export interface HeaderPreview { readonly row: HeaderRow; readonly top: number; readonly left: number; readonly document: Document }
const captions: Readonly<Record<string, string>> = { online: '在线', offline: '离线', unauthorized: '待授权', unknown: '未知' };
const text: Readonly<Record<string, string>> = { online: 'text-success', offline: 'text-ghost', unauthorized: 'text-warning', unknown: 'text-ghost' };
const dots: Readonly<Record<string, string>> = { online: 'bg-success', offline: 'bg-ghost', unauthorized: 'bg-warning', unknown: 'bg-hairline-strong' };
export const stateCaption = (state: string) => captions[state] ?? state;
export const stateDot = (state: string) => dots[state] ?? dots.unknown;
export function headerRows(snapshot: DeviceSnapshot): readonly HeaderRow[] {
  return snapshot.directories.filter((entry) => snapshot.providers.some((provider) =>
    provider.id === entry.provider.id && provider.generation === entry.provider.generation))
    .flatMap((entry) => entry.devices.map((device) => ({
      device, platform: entry.provider.definition.platform, observedAt: entry.observedAt,
    })));
}
function platform(platform: string) {
  const key = platform.trim().toLowerCase();
  if (key.includes('android')) return { letter: 'A', label: 'Android', color: 'bg-platform-android-tint text-platform-android', idle: 'bg-platform-android-idle-tint text-platform-android-idle' };
  if (['ios', 'iphone', 'ipad', 'apple'].some((part) => key.includes(part))) return { letter: 'i', label: 'iOS', color: 'bg-platform-ios-tint text-platform-ios', idle: 'bg-platform-ios-tint text-platform-ios opacity-60' };
  if (['harmony', 'ohos', 'hongmeng'].some((part) => key.includes(part))) return { letter: 'H', label: '鸿蒙', color: 'bg-platform-harmony-tint text-platform-harmony', idle: 'bg-platform-harmony-tint text-platform-harmony opacity-60' };
  return { letter: key.includes('emulator') || key.includes('simulator') ? 'E' : platform.trim().slice(0, 1).toUpperCase() || '?',
    label: key.includes('emulator') || key.includes('simulator') ? '模拟器' : platform || '未知平台',
    color: 'bg-platform-emulator-tint text-platform-emulator', idle: 'bg-platform-emulator-tint text-platform-emulator opacity-60' };
}
export function HeaderBadge({ row, small = false }: { readonly row: HeaderRow; readonly small?: boolean }) {
  const tone = platform(row.platform);
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center font-mono font-bold leading-none ${small ? 'size-4 rounded-[5px] text-[10px]' : 'size-8 rounded-[9px] text-[12px]'} ${row.device.state === 'online' ? tone.color : tone.idle}`}>{tone.letter}</span>;
}
export function HeaderIcon({ name, className = 'size-3' }: {
  readonly name: 'phone' | 'down' | 'right' | 'refresh'; readonly className?: string;
}) {
  const paths = { phone: 'M8 2h8v20H8z M11 18h2', down: 'm6 9 6 6 6-6',
    right: 'm9 6 6 6-6 6', refresh: 'M20 6v6h-6 M20 12a8 8 0 1 0-2 5 M20 6l-3-2' };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d={paths[name]} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
export function DeviceHeaderRow({ row, checked, preview, clear }: {
  readonly row: HeaderRow; readonly checked: boolean;
  readonly preview: (row: HeaderRow, element: HTMLElement) => void; readonly clear: () => void;
}) {
  return <DropdownMenuRadioItem value={deviceIdentity(row.device.reference)}
    onPointerEnter={(event) => preview(row, event.currentTarget)} onPointerLeave={clear}
    onFocus={(event) => preview(row, event.currentTarget)} onBlur={clear}>
    <span className={`relative grid h-[52px] grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-4 ${checked ? 'bg-accent/45' : ''}`}>
      {checked && <span aria-hidden="true" className="absolute left-0 top-3.5 h-6 w-[3px] rounded-r-sm bg-primary" />}
      <HeaderBadge row={row} />
      <span className="flex min-w-0 flex-col gap-0.5"><span className={`truncate text-[13.5px] ${row.device.state === 'online' ? 'font-semibold text-ink' : 'font-medium text-body'}`}>{row.device.model ?? row.device.reference.localId}</span>
        <span className="truncate font-mono text-[11px] text-faint">{row.device.reference.localId}</span></span>
      <span className={`whitespace-nowrap text-[11px] font-medium ${text[row.device.state] ?? text.unknown}`}>{stateCaption(row.device.state)}</span>
    </span>
  </DropdownMenuRadioItem>;
}
interface PreviewPosition extends CSSProperties { '--device-preview-top': string; '--device-preview-left': string }
function PreviewBody({ preview, contentRef }: { readonly preview: HeaderPreview; readonly contentRef?: Ref<HTMLDivElement> }) {
  const { row } = preview;
  const style: PreviewPosition = { '--device-preview-top': `${preview.top}px`, '--device-preview-left': `${preview.left}px` };
  return <div ref={contentRef} role="presentation" style={style}
    className="pointer-events-none fixed left-[var(--device-preview-left)] top-[var(--device-preview-top)] z-[60] w-[232px] rounded-[12px] border border-hairline bg-card p-3.5 shadow-preview">
    <div className="flex min-w-0 items-center gap-2.5"><HeaderBadge row={row} />
      <span className="flex min-w-0 flex-col gap-0.5"><strong className="truncate text-[13px] font-semibold text-ink">{row.device.model ?? row.device.reference.localId}</strong>
        <span className={`text-[11px] ${text[row.device.state] ?? text.unknown}`}>{stateCaption(row.device.state)}</span></span></div>
    <span className="mt-2 block break-all font-mono text-[11px] text-faint">{row.device.reference.localId}</span>
    <dl className="mt-2.5 flex flex-col gap-1.5 border-t border-hairline pt-2.5 text-[11px]">
      <div className="flex justify-between gap-2.5"><dt className="shrink-0 text-faint">平台</dt><dd className="min-w-0 truncate text-body">{platform(row.platform).label}</dd></div>
      <div className="flex justify-between gap-2.5"><dt className="shrink-0 text-faint">提供者</dt><dd className="min-w-0 truncate font-mono text-body">{row.device.reference.providerId}</dd></div>
      <div className="flex justify-between gap-2.5"><dt className="shrink-0 text-faint">最近观测</dt><dd className="font-mono text-body">{new Date(row.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}</dd></div>
    </dl>
  </div>;
}
type PortalHook = NonNullable<ReturnType<typeof hostUi>['usePortalContentRef']>;
function OwnedPreview({ preview, useContentRef }: { readonly preview: HeaderPreview; readonly useContentRef: PortalHook }) {
  const ref = useContentRef<HTMLDivElement>(undefined);
  return <PreviewBody preview={preview} contentRef={ref} />;
}
export function DeviceHeaderPreview({ preview }: { readonly preview: HeaderPreview }) {
  const [useContentRef] = useState(() => hostUi().usePortalContentRef);
  return createPortal(useContentRef ? <OwnedPreview preview={preview} useContentRef={useContentRef} /> : <PreviewBody preview={preview} />, preview.document.body);
}
