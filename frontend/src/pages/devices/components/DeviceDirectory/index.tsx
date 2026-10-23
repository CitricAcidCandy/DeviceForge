import { useState } from 'react';
import { ChevronLeft, ChevronRight, PlugZap, RefreshCw, Search } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { Input } from '../../../../components/Input/index.tsx';
import { DeviceBadge } from '../../../../components/DeviceBadge/index.tsx';
import {
  devicePlatformLetter,
  devicePlatformLabel,
  devicePlatformTone,
  deviceStateCaption,
  deviceStateLabel,
  deviceStateTone,
} from '../../../../features/devices/index.ts';
import type {
  DeviceProviderInfo,
  DeviceRef,
  DeviceSnapshot,
} from '../../../../plugin-sdk/index.ts';
import { deviceKey, providerKey, sameDevice } from '../../workspace.ts';
import { cn } from '../../../../utils/classnames.ts';

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
 * 设备选择：一台设备一张卡，平台徽标先说话，标识用等宽，状态只上色不铺底。
 * 左列是设备清单（在线在前），右列是「当前选择 + 设备提供者」——提供者从列表脚注搬到这里，
 * 列表因此只是设备清单，选择动作不再和「重新发现」抢注意力。
 * 样式全部是 Tailwind 工具类，没有配套 CSS 文件。
 */
export function DeviceDirectory({
  snapshot,
  pending,
  select,
  discover,
  discoverAll,
  read,
  connect,
  titleOf,
  onClose,
}: {
  snapshot: DeviceSnapshot;
  pending: boolean;
  select(reference: DeviceRef): void;
  discover(provider: DeviceProviderInfo): void;
  discoverAll(): void;
  read(): void;
  connect(): void;
  // 能力只报「能做什么」，不报操作 id——标题从操作目录里取。
  titleOf(operation: string): string;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const devices = snapshot.directories.flatMap((directory) =>
    directory.devices.map((device) => ({ directory, device })),
  );
  const platforms = [...new Set(snapshot.providers.map((item) => item.definition.platform))];
  const effectiveSource = platforms.includes(source) ? source : 'all';
  const countOf = (platform: string) =>
    devices.filter(({ directory }) => directory.provider.definition.platform === platform).length;
  const keyword = query.trim().toLocaleLowerCase();
  const matching = devices.filter(
    ({ directory, device }) =>
      (effectiveSource === 'all' || directory.provider.definition.platform === effectiveSource) &&
      [
        device.model ?? '',
        device.reference.localId,
        device.rawState ?? '',
        directory.provider.id,
        directory.provider.definition.platform,
      ].some((value) => value.toLocaleLowerCase().includes(keyword)),
  );
  const onlineCount = devices.filter(({ device }) => device.state === 'online').length;
  // 全在线时别把同一个数字报两遍。
  const countLabel = !devices.length
    ? '还没有设备'
    : onlineCount === devices.length
      ? `${devices.length} 台设备 · 全部在线`
      : `${devices.length} 台设备 · ${onlineCount} 台在线`;
  const groups = [
    {
      id: 'online',
      label: '在线',
      rows: matching.filter(({ device }) => device.state === 'online'),
    },
    {
      id: 'idle',
      label: '离线与待授权',
      rows: matching.filter(({ device }) => device.state !== 'online'),
    },
  ].filter((group) => group.rows.length > 0);
  const selected = snapshot.selected;
  const selectedProvider = snapshot.providers.find(
    (provider) =>
      selected &&
      provider.id === selected.reference.providerId &&
      provider.generation === selected.reference.generation,
  );
  const selectedDirectory = snapshot.directories.find(
    (directory) =>
      selected !== null &&
      directory.provider.id === selected.reference.providerId &&
      directory.provider.generation === selected.reference.generation,
  );
  const availableNames = selected
    ? [
        ...new Set(
          selected.capabilities
            .filter((capability) => capability.available)
            .map((capability) => {
              const declared = selectedProvider?.definition.capabilities.find(
                (item) => item.id === capability.id && item.version === capability.version,
              );
              return titleOf(declared?.operation ?? capability.id);
            }),
        ),
      ]
    : [];
  // 右栏只容四枚；剩下的折成 +N，悬停仍可看全量。
  const shownNames = availableNames.slice(0, 4);
  const hiddenNames = availableNames.length - shownNames.length;
  const timeOf = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
  const emptyTitle = snapshot.providers.length
    ? devices.length
      ? '没有匹配的设备'
      : '尚未发现设备'
    : '还没有可用的设备提供者';
  const emptyHint = snapshot.providers.length
    ? devices.length
      ? '换个搜索词或来源。'
      : '连接设备后点「发现设备」，并确认设备端已授权。'
    : '在市场页「已安装」启用设备提供者，回到这里重新发现。';
  return (
    <section aria-label="选择设备" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-5 border-b border-hairline px-7 pb-[18px] pt-[22px] max-[1180px]:px-5 max-[1180px]:pb-4 max-[1180px]:pt-[18px]">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="退出设备选择"
            title="退出设备选择"
            className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-card text-body hover:border-hairline-strong hover:text-ink"
          >
            <ChevronLeft aria-hidden="true" className="size-3.5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold leading-tight tracking-[-0.01em] text-ink">
              选择设备
            </h1>
            <p className="mt-1 text-xs text-faint">
              {countLabel}
              {pending ? ' · 正在读取目录' : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={read}>
            <RefreshCw aria-hidden="true" />
            读取目录
          </Button>
          <Button size="sm" disabled={pending} onClick={discoverAll}>
            发现设备
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={snapshot.providers.length === 0}
            onClick={connect}
          >
            连接地址
          </Button>
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-3.5 border-b border-hairline px-7 py-3.5 max-[1180px]:px-5 max-[1180px]:py-3 max-[900px]:flex-wrap">
        <div className="flex h-9 min-w-[180px] flex-1 basis-[340px] items-center gap-2 rounded-[10px] border border-hairline bg-card px-2.5 text-ghost focus-within:border-primary/45">
          <Search aria-hidden="true" className="size-3.5 shrink-0" />
          <Input
            aria-label="搜索设备"
            placeholder="搜索名称、标识或提供者"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-[30px] border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
          />
        </div>
        <div
          role="group"
          aria-label="设备来源"
          className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none]"
        >
          <button
            type="button"
            aria-pressed={effectiveSource === 'all'}
            onClick={() => setSource('all')}
            className={cn(
              'inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[13px]',
              effectiveSource === 'all'
                ? 'border-transparent bg-accent font-semibold text-primary'
                : 'border-hairline bg-card text-body hover:border-hairline-strong',
            )}
          >
            全部
            <b
              className={cn(
                'font-normal',
                effectiveSource === 'all' ? 'text-primary' : 'text-faint',
              )}
            >
              {devices.length}
            </b>
          </button>
          {platforms.map((platform) => {
            const pressed = effectiveSource === platform;
            return (
              <button
                key={platform}
                type="button"
                aria-pressed={pressed}
                onClick={() => setSource(platform)}
                className={cn(
                  'inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[13px]',
                  pressed
                    ? 'border-transparent bg-accent font-semibold text-primary'
                    : 'border-hairline bg-card text-body hover:border-hairline-strong',
                )}
              >
                {devicePlatformLabel(platform)}
                <b className={cn('font-normal', pressed ? 'text-primary' : 'text-faint')}>
                  {countOf(platform)}
                </b>
              </button>
            );
          })}
          {platforms.length === 0 ? (
            <span className="inline-flex h-8 items-center rounded-full border border-hairline bg-card px-3 text-[13px] text-ghost">
              无提供者
            </span>
          ) : null}
        </div>
        <span className="ml-auto whitespace-nowrap text-xs text-ghost max-[1180px]:hidden">
          最近在线优先
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-7 px-7 pb-6 pt-[18px] max-[1180px]:grid-cols-[minmax(0,1fr)_320px] max-[1180px]:gap-5 max-[1180px]:px-5 max-[1180px]:pb-5 max-[1180px]:pt-4 max-[900px]:grid-cols-1 max-[900px]:overflow-y-auto">
        <div
          aria-label="已发现设备"
          className="flex min-h-0 flex-col gap-[18px] overflow-y-auto pr-1 [scrollbar-width:thin] max-[900px]:overflow-visible"
        >
          {groups.map((group) => (
            <section className="flex flex-col gap-2.5" key={group.id}>
              <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-ghost">
                {group.label} <b className="font-medium">{group.rows.length}</b>
              </h2>
              {group.rows.map(({ directory, device }) => {
                const platform = directory.provider.definition.platform;
                const current = sameDevice(snapshot.selection, device.reference);
                const usable = device.capabilities.filter((item) => item.available).length;
                const idle = device.state !== 'online';
                return (
                  <button
                    type="button"
                    key={deviceKey(device.reference)}
                    data-selected={current ? 'true' : undefined}
                    data-device-reference={deviceKey(device.reference)}
                    aria-pressed={current}
                    aria-label={`选择设备 ${device.model ?? device.reference.localId}，${platform}，${device.reference.localId}`}
                    onClick={() => select(device.reference)}
                    className={cn(
                      'grid h-[92px] w-full grid-cols-[44px_minmax(0,1fr)_auto_16px] items-center gap-3.5 rounded-xl border bg-card px-4 text-left transition-colors',
                      current
                        ? 'border-primary bg-accent/20'
                        : 'border-hairline hover:border-hairline-strong hover:shadow-[0_10px_26px_-22px_rgba(23,27,36,0.55)]',
                    )}
                  >
                    <DeviceBadge
                      tone={devicePlatformTone(platform)}
                      letter={devicePlatformLetter(platform)}
                      size="lg"
                      idle={idle}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[15px] font-semibold text-ink">
                        {device.model ?? device.reference.localId}
                      </span>
                      <span className="truncate font-mono text-xs text-faint">
                        {device.reference.localId}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {devicePlatformLabel(platform)} · {usable} 项能力 ·{' '}
                        {timeOf(directory.observedAt)} 观测
                      </span>
                    </span>
                    <span
                      className={cn(
                        'whitespace-nowrap text-xs font-semibold',
                        stateText[deviceStateTone(device.state)],
                      )}
                    >
                      {deviceStateCaption(device.state)}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className={cn('size-4', current ? 'text-primary' : 'text-ghost')}
                    />
                  </button>
                );
              })}
            </section>
          ))}
          {matching.length === 0 ? (
            <div className="m-auto flex flex-col items-center gap-2 px-4 py-10 text-center text-[13px] text-faint">
              <span className="grid size-10 place-items-center rounded-full bg-surface-sunken text-faint">
                <PlugZap aria-hidden="true" className="size-[18px]" />
              </span>
              <strong className="text-[15px] font-semibold text-body">{emptyTitle}</strong>
              <span className="max-w-[320px] leading-relaxed">{emptyHint}</span>
              {snapshot.providers.length ? (
                <Button size="sm" disabled={pending} onClick={discoverAll} className="mt-1.5">
                  发现设备
                </Button>
              ) : (
                <Button size="sm" asChild className="mt-1.5">
                  <a href="#marketplace">去市场页启用</a>
                </Button>
              )}
            </div>
          ) : null}
        </div>
        <aside
          aria-label="当前选择"
          className="flex min-h-0 flex-col gap-4 overflow-y-auto [scrollbar-width:thin] max-[900px]:order-first max-[900px]:overflow-visible"
        >
          <section className="flex flex-col gap-3 rounded-[14px] border border-hairline bg-card p-[18px] max-[1180px]:p-4">
            <h2 className="text-[11px] font-semibold tracking-[0.06em] text-faint">当前选择</h2>
            {selected ? (
              <>
                <div className="flex min-w-0 items-center gap-2.5">
                  <DeviceBadge
                    tone={devicePlatformTone(selectedProvider?.definition.platform ?? '')}
                    letter={devicePlatformLetter(selectedProvider?.definition.platform ?? '')}
                    idle={selected.state !== 'online'}
                  />
                  <div className="min-w-0">
                    <strong className="block truncate text-[19px] font-semibold text-ink">
                      {selected.model ?? selected.reference.localId}
                    </strong>
                    <span className="mt-0.5 block truncate font-mono text-xs text-faint">
                      {selected.reference.localId}
                    </span>
                  </div>
                </div>
                <span
                  className={cn('text-xs font-medium', stateText[deviceStateTone(selected.state)])}
                >
                  {deviceStateLabel(selected.state)}
                </span>
                <dl className="grid grid-cols-2 border-y border-hairline py-1 [&>div]:min-w-0 [&>div]:py-2.5 [&>div:nth-child(odd)]:pr-3">
                  <div>
                    <dt className="text-[11px] text-faint">平台</dt>
                    <dd className="mt-0.5 truncate text-[13px] text-ink">
                      {devicePlatformLabel(selectedProvider?.definition.platform ?? '')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-faint">代次</dt>
                    <dd className="mt-0.5 truncate font-mono text-[13px] text-ink">
                      {selected.reference.generation}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-faint">提供者</dt>
                    <dd className="mt-0.5 truncate font-mono text-[13px] text-ink">
                      {selected.reference.providerId}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-faint">观测</dt>
                    <dd className="mt-0.5 truncate font-mono text-[13px] text-ink">
                      {selectedDirectory ? timeOf(selectedDirectory.observedAt) : '—'}
                    </dd>
                  </div>
                </dl>
                <h3 className="text-[11px] font-semibold tracking-[0.06em] text-faint">能力</h3>
                <div
                  className="flex flex-wrap gap-1.5"
                  title={availableNames.join('、') || undefined}
                >
                  {shownNames.length ? (
                    <>
                      {shownNames.map((name) => (
                        <span
                          key={name}
                          className="inline-flex h-6 items-center rounded-md bg-surface-sunken px-2 text-[11.5px] text-body"
                        >
                          {name}
                        </span>
                      ))}
                      {hiddenNames > 0 ? (
                        <span className="inline-flex h-6 items-center rounded-md bg-surface-sunken px-2 font-mono text-[11.5px] text-ghost">
                          +{hiddenNames}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="inline-flex h-6 items-center rounded-md bg-surface-sunken px-2 text-[11.5px] text-ghost">
                      暂无可用能力
                    </span>
                  )}
                </div>
                <Button className="h-10 w-full text-sm" onClick={onClose}>
                  进入工作台
                </Button>
                <button
                  type="button"
                  onClick={connect}
                  className="py-0.5 text-xs text-muted-foreground hover:text-primary"
                >
                  直接输入连接地址
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2.5 py-6 text-[13px] text-ghost">
                <PlugZap aria-hidden="true" className="size-[18px]" />
                <span>先选择一台设备</span>
              </div>
            )}
          </section>
          <section
            aria-label="设备提供者"
            className="flex flex-col gap-0.5 rounded-[14px] border border-hairline bg-card p-[18px] max-[1180px]:p-4 max-[1024px]:hidden max-[900px]:block"
          >
            <h2 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-faint">
              设备提供者
            </h2>
            {snapshot.providers.length === 0 ? (
              <p className="text-xs text-ghost">还没有加载设备提供者。</p>
            ) : null}
            {snapshot.providers.map((provider) => {
              const directory = snapshot.directories.find(
                (item) => providerKey(item.provider) === providerKey(provider),
              );
              const tone = directory
                ? directory.devices.length
                  ? 'online'
                  : 'unknown'
                : 'offline';
              return (
                <div
                  key={providerKey(provider)}
                  className="grid h-[34px] grid-cols-[6px_minmax(0,1fr)_auto_24px] items-center gap-2.5"
                >
                  <span aria-hidden="true" className={cn('size-1.5 rounded-full', stateDot[tone])} />
                  <span className="truncate font-mono text-[11.5px] text-body">{provider.id}</span>
                  <span className="whitespace-nowrap text-[11px] text-faint max-[1024px]:hidden">
                    {directory
                      ? `${directory.devices.length} 台 · ${timeOf(directory.observedAt)} 观测`
                      : '尚无观测'}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`重新发现 ${provider.id}`}
                    title={`重新发现 ${provider.id}`}
                    onClick={() => discover(provider)}
                    className="grid size-6 place-items-center rounded-md text-ghost hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                  >
                    <RefreshCw aria-hidden="true" className="size-[13px]" />
                  </button>
                </div>
              );
            })}
          </section>
        </aside>
      </div>
    </section>
  );
}
