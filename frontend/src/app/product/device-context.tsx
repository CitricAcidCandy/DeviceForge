import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, RefreshCw, Smartphone } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/DropdownMenu/index.tsx';
import { Button } from '../../components/Button/index.tsx';
import { DeviceBadge } from '../../components/DeviceBadge/index.tsx';
import {
  devicePlatformLetter,
  devicePlatformLabel,
  devicePlatformTone,
  deviceStateCaption,
  deviceStateTone,
  discoverProviders,
} from '../../features/devices/index.ts';
import type { DeviceRef, ProvidedDevice } from '../../plugin-sdk/index.ts';
import type { ProductServices } from './services.ts';
import { useSnapshot } from './hooks.ts';
import { cn } from '../../utils/classnames.ts';

type Row = { device: ProvidedDevice; platform: string; observedAt: number };
type Preview = { row: Row; top: number; left: number };

const clock = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });

const stateText: Record<string, string> = {
  online: 'text-success',
  offline: 'text-ghost',
  unauthorized: 'text-warning',
  unknown: 'text-ghost',
};
const stateDot: Record<string, string> = {
  online: 'bg-success',
  offline: 'bg-ghost',
  unauthorized: 'bg-warning',
  unknown: 'bg-hairline-strong',
};

/*
 * 顶栏设备胶囊：一颗胶囊说清「现在在哪台设备上」，点开是同一套设备身份的弹窗。
 * 弹窗里能直接发现设备，不用为了刷新目录跳去设备页；悬停某一行，右侧浮卡给出这台设备的基础信息。
 * 样式全部是 Tailwind 工具类，没有配套 CSS 文件。
 */
export function DeviceContext({ services }: { services: ProductServices }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const [open, setOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const rows: Row[] = snapshot.directories.flatMap((directory) =>
    directory.devices.map((device) => ({
      device,
      platform: directory.provider.definition.platform,
      observedAt: directory.observedAt,
    })),
  );
  const keyOf = (reference: DeviceRef) => JSON.stringify(reference);
  const selectedKey = snapshot.selection ? keyOf(snapshot.selection) : '';
  const current = rows.find((row) => keyOf(row.device.reference) === selectedKey) ?? null;
  const online = rows.filter((row) => row.device.state === 'online');
  const rest = rows.filter((row) => row.device.state !== 'online');
  const countLabel = rows.length ? `${rows.length} 台 · ${online.length} 在线` : '0 台';
  const label = current ? (current.device.model ?? current.device.reference.localId) : '选择设备';

  const choose = (key: string) => {
    const chosen = rows.find((row) => keyOf(row.device.reference) === key);
    services.runtime.devices.select(chosen?.device.reference ?? null);
  };

  async function discover() {
    if (discovering) return;
    const controller = new AbortController();
    running.current = controller;
    setDiscovering(true);
    try {
      const result = await discoverProviders(services.runtime.devices, controller.signal);
      const { discovered, failures } = result.data;
      if (failures.length) {
        services.messages.warning(`${failures.length} 个提供者没能发现`, {
          description: `另有 ${discovered} 个提供者已刷新`,
          logId: result.logId,
          details: failures.map((failure) => ({
            label: failure.provider,
            message: failure.message,
            logId: failure.logId,
          })),
        });
      } else {
        services.messages.success(`已刷新 ${discovered} 个提供者的设备目录`, {
          logId: result.logId,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      services.messages.error(
        '发现设备失败',
        error instanceof Error ? { description: error.message } : undefined,
      );
    } finally {
      setDiscovering(false);
      running.current = null;
    }
  }

  // 悬停/聚焦给一张浮卡；右侧放不下就翻到行的左边。
  const showPreview = (row: Row, element: HTMLElement) => {
    if (window.innerWidth < 900) return;
    const box = element.getBoundingClientRect();
    const width = 232;
    const gap = 10;
    const left =
      box.right + gap + width > window.innerWidth - 12 ? box.left - gap - width : box.right + gap;
    setPreview({ row, top: Math.round(box.top - 6), left: Math.round(left) });
  };

  const renderRow = (row: Row) => {
    const key = keyOf(row.device.reference);
    const tone = devicePlatformTone(row.platform);
    const state = deviceStateTone(row.device.state);
    const idle = row.device.state === 'online' ? false : true;
    const checked = key === selectedKey;
    return (
      <DropdownMenuRadioItem
        key={key}
        value={key}
        // Radix 自带的圆点指示器用不上（选中态是底色 + 左侧竖条），藏掉它的第一个 span。
        className="block rounded-lg p-0 focus:bg-surface-hover focus:text-inherit [&>span:first-child]:hidden"
        onPointerEnter={(event) => showPreview(row, event.currentTarget)}
        onPointerLeave={() => setPreview(null)}
        onFocus={(event) => showPreview(row, event.currentTarget)}
        onBlur={() => setPreview(null)}
      >
        <span
          className={cn(
            'relative grid h-[52px] grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-4',
            checked && 'bg-accent/45',
          )}
        >
          {checked ? (
            <span
              aria-hidden="true"
              className="absolute left-0 top-3.5 h-6 w-[3px] rounded-r-sm bg-primary"
            />
          ) : null}
          <DeviceBadge tone={tone} letter={devicePlatformLetter(row.platform)} idle={idle} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                'truncate text-[13.5px] text-ink',
                idle ? 'font-medium text-body' : 'font-semibold',
              )}
            >
              {row.device.model ?? row.device.reference.localId}
            </span>
            <span className="truncate font-mono text-[11px] text-faint">
              {row.device.reference.localId}
            </span>
          </span>
          <span
            className={cn('whitespace-nowrap text-[11px] font-medium', stateText[state])}
          >
            {deviceStateCaption(row.device.state)}
          </span>
        </span>
      </DropdownMenuRadioItem>
    );
  };

  const previewTone = preview ? devicePlatformTone(preview.row.platform) : null;

  return (
    <div data-slot="device-context" className="ml-2.5 inline-flex shrink-0 items-center">
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPreview(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="选择当前设备"
            className={cn(
              'group inline-flex h-[26px] max-w-[260px] items-center gap-1.5 rounded-full border border-transparent bg-surface-sunken px-2.5 text-[12.5px] text-body',
              'hover:bg-surface-hover data-[state=open]:border-hairline-strong data-[state=open]:bg-card',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/55',
              'max-[900px]:max-w-[168px]',
              !current && 'border-dashed border-hairline-strong font-medium',
            )}
          >
            {current ? (
              <DeviceBadge
                tone={devicePlatformTone(current.platform)}
                letter={devicePlatformLetter(current.platform)}
                size="sm"
                idle={current.device.state !== 'online'}
              />
            ) : null}
            <span className="min-w-0 truncate font-semibold text-ink">{label}</span>
            {current ? (
              <span
                aria-hidden="true"
                className={cn(
                  'size-[5px] shrink-0 rounded-full',
                  stateDot[deviceStateTone(current.device.state)],
                )}
              />
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className="size-2.5 shrink-0 text-faint transition-transform group-data-[state=open]:rotate-180"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="flex w-[372px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[14px] border border-hairline bg-card p-0 shadow-pop"
        >
          <div className="flex h-[46px] shrink-0 items-center justify-between gap-3 border-b border-hairline px-4">
            <span className="text-[11px] font-semibold tracking-[0.02em] text-faint">切换设备</span>
            <span className="font-mono text-[11px] text-ghost">{countLabel}</span>
          </div>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-5 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-surface-sunken text-faint">
                <Smartphone aria-hidden="true" className="size-[18px]" />
              </span>
              <strong className="text-[13px] font-semibold text-ink">尚未发现设备</strong>
              <p className="max-w-[240px] text-[11.5px] leading-relaxed text-faint">
                连接设备后点下方「发现设备」，或直接在设备页输入连接地址。
              </p>
              <Button size="sm" asChild className="mt-1 min-w-28">
                <a href="#devices" onClick={() => setOpen(false)}>
                  去设备页
                </a>
              </Button>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto py-1" onScroll={() => setPreview(null)}>
              <DropdownMenuRadioGroup value={selectedKey} onValueChange={choose}>
                {online.length ? (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="px-4 pb-1 pt-1.5 text-[11px] font-medium text-ghost">
                      在线
                    </DropdownMenuLabel>
                    {online.map(renderRow)}
                  </DropdownMenuGroup>
                ) : null}
                {rest.length ? (
                  <DropdownMenuGroup>
                    <DropdownMenuSeparator className="mx-4 my-1.5 h-px bg-hairline" />
                    <DropdownMenuLabel className="px-4 pb-1 pt-1.5 text-[11px] font-medium text-ghost">
                      离线与待授权
                    </DropdownMenuLabel>
                    {rest.map(renderRow)}
                  </DropdownMenuGroup>
                ) : null}
              </DropdownMenuRadioGroup>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-0.5 border-t border-hairline p-1">
            <DropdownMenuItem
              disabled={discovering}
              className="gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-primary data-[disabled]:text-ghost"
              // 刷新期间弹窗留在原地：用户要看到列表跟着变。
              onSelect={(event) => {
                event.preventDefault();
                void discover();
              }}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn('size-3', discovering && 'animate-spin')}
              />
              发现设备
            </DropdownMenuItem>
            {current ? (
              <DropdownMenuItem
                className="rounded-md px-2.5 py-1.5 text-[11.5px] text-faint"
                onSelect={() => choose('')}
              >
                清除选择
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              asChild
              className="ml-auto gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-primary"
            >
              <a href="#devices" onClick={() => setOpen(false)}>
                在设备页里选择
                <ChevronRight aria-hidden="true" className="size-3" />
              </a>
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {preview && previewTone && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="presentation"
              style={{ top: preview.top, left: preview.left }}
              className="pointer-events-none fixed z-[60] hidden w-[232px] rounded-[12px] border border-hairline bg-card p-3.5 shadow-preview min-[900px]:block"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <DeviceBadge
                  tone={previewTone}
                  letter={devicePlatformLetter(preview.row.platform)}
                  idle={preview.row.device.state !== 'online'}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <strong className="truncate text-[13px] font-semibold text-ink">
                    {preview.row.device.model ?? preview.row.device.reference.localId}
                  </strong>
                  <span
                    className={cn(
                      'text-[11px]',
                      stateText[deviceStateTone(preview.row.device.state)],
                    )}
                  >
                    {deviceStateCaption(preview.row.device.state)}
                  </span>
                </span>
              </div>
              <span className="mt-2 block font-mono text-[11px] text-faint break-all">
                {preview.row.device.reference.localId}
              </span>
              <dl className="mt-2.5 flex flex-col gap-1.5 border-t border-hairline pt-2.5">
                <div className="flex min-w-0 items-baseline justify-between gap-2.5">
                  <dt className="shrink-0 text-[11px] text-faint">平台</dt>
                  <dd className="min-w-0 truncate text-right text-[11.5px] text-body">
                    {devicePlatformLabel(preview.row.platform)}
                  </dd>
                </div>
                <div className="flex min-w-0 items-baseline justify-between gap-2.5">
                  <dt className="shrink-0 text-[11px] text-faint">提供者</dt>
                  <dd className="min-w-0 truncate text-right font-mono text-[11px] text-body">
                    {preview.row.device.reference.providerId}
                  </dd>
                </div>
                <div className="flex min-w-0 items-baseline justify-between gap-2.5">
                  <dt className="shrink-0 text-[11px] text-faint">观测</dt>
                  <dd className="min-w-0 truncate text-right font-mono text-[11px] text-body">
                    {clock(preview.row.observedAt)}
                  </dd>
                </div>
                <div className="flex min-w-0 items-baseline justify-between gap-2.5">
                  <dt className="shrink-0 text-[11px] text-faint">能力</dt>
                  <dd className="min-w-0 truncate text-right text-[11.5px] text-body">
                    {preview.row.device.capabilities.filter((item) => item.available).length} /{' '}
                    {preview.row.device.capabilities.length} 可用
                  </dd>
                </div>
              </dl>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
