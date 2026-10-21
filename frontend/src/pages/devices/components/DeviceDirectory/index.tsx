import { useState } from 'react';
import { ChevronLeft, PlugZap, RefreshCw, Search } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { Input } from '../../../../components/Input/index.tsx';
import type {
  DeviceProviderInfo,
  DeviceRef,
  DeviceSnapshot,
} from '../../../../plugin-sdk/index.ts';
import { deviceKey, deviceStates, providerKey, sameDevice } from '../../workspace.ts';
import './workspace.css';

/*
 * 设备选择：一台设备一段证据，选完就进工作台。
 * 左栏是来源，中间是设备（发丝线分隔，不用卡片），右栏只报当前选择的身份与能力。
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
  const timeOf = (value: number) =>
    new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
  const emptyTitle = snapshot.providers.length
    ? devices.length
      ? '没有匹配的设备'
      : '尚未发现设备'
    : '还没有可用的设备提供者';
  const emptyHint = snapshot.providers.length
    ? devices.length
      ? '换个搜索词或来源。'
      : '连接设备后点「发现设备」，并确认设备端已授权。'
    : '在插件页启用设备提供者，回到这里重新发现。';
  return (
    <section className="device-picker" aria-label="选择设备">
      <header className="picker-head">
        <div className="picker-heading">
          <div className="picker-heading-row">
            <button
              type="button"
              className="picker-back"
              onClick={onClose}
              aria-label="退出设备选择"
              title="退出设备选择"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <h1>选择设备</h1>
          </div>
          <span className="picker-count mono">
            {devices.length} 台 · {onlineCount} 台在线
            {pending ? ' · 正在读取' : ''}
          </span>
        </div>
        <div className="picker-actions">
          <div className="picker-search">
            <Search aria-hidden="true" />
            <Input
              aria-label="搜索设备"
              placeholder="搜索名称或标识"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button type="button" className="picker-link" disabled={pending} onClick={read}>
            读取目录
          </button>
          <button type="button" className="picker-link" disabled={pending} onClick={discoverAll}>
            发现设备
          </button>
          <button
            type="button"
            className="picker-link"
            disabled={snapshot.providers.length === 0}
            onClick={connect}
          >
            连接地址
          </button>
        </div>
      </header>
      <div className="picker-body">
        <nav className="picker-sources" aria-label="设备来源">
          <span className="picker-label">来源</span>
          <button
            type="button"
            className="picker-source"
            aria-pressed={effectiveSource === 'all'}
            onClick={() => setSource('all')}
          >
            <span>全部</span>
            <b className="mono">{devices.length}</b>
          </button>
          {platforms.map((platform) => (
            <button
              key={platform}
              type="button"
              className="picker-source"
              aria-pressed={effectiveSource === platform}
              onClick={() => setSource(platform)}
            >
              <span>{platform}</span>
              <b className="mono">{countOf(platform)}</b>
            </button>
          ))}
          {platforms.length === 0 ? <span className="picker-source is-idle">无提供者</span> : null}
        </nav>
        <div className="picker-main">
          <div className="picker-columns" aria-hidden="true">
            <span />
            <span>设备</span>
            <span>标识</span>
            <span>能力</span>
            <span>观测</span>
            <span />
          </div>
          <div className="picker-rows" aria-label="已发现设备">
            {matching.map(({ directory, device }) => {
              const current = sameDevice(snapshot.selection, device.reference);
              const usable = device.capabilities.filter((item) => item.available).length;
              return (
                <button
                  type="button"
                  key={deviceKey(device.reference)}
                  className="picker-row"
                  data-selected={current ? 'true' : undefined}
                  data-device-reference={deviceKey(device.reference)}
                  aria-pressed={current}
                  aria-label={`选择设备 ${device.model ?? device.reference.localId}，${device.reference.providerId}，${device.reference.localId}`}
                  onClick={() => select(device.reference)}
                >
                  <span className="picker-dot" data-state={device.state} aria-hidden="true" />
                  <span className="picker-name">
                    <strong>{device.model ?? device.reference.localId}</strong>
                    <small>
                      {directory.provider.definition.platform} · {deviceStates[device.state]}
                    </small>
                  </span>
                  <span className="picker-id mono">{device.reference.localId}</span>
                  <span className="picker-caps mono">{usable} 项</span>
                  <span className="picker-seen mono">{timeOf(directory.observedAt)}</span>
                  <span className="picker-go">{current ? '已选' : '选择'}</span>
                </button>
              );
            })}
            {matching.length === 0 ? (
              <div className="picker-empty">
                <strong>{emptyTitle}</strong>
                <span>{emptyHint}</span>
                {snapshot.providers.length === 0 ? (
                  <Button size="sm" asChild>
                    <a href="#plugins">去插件页启用</a>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <section className="picker-providers" aria-label="设备提供者">
            <span className="picker-label">提供者</span>
            {snapshot.providers.length === 0 ? (
              <p className="picker-provider-note">还没有加载设备提供者。</p>
            ) : null}
            {snapshot.providers.map((provider) => {
              const directory = snapshot.directories.find(
                (item) => providerKey(item.provider) === providerKey(provider),
              );
              return (
                <div key={providerKey(provider)} className="picker-provider">
                  <span
                    className="picker-dot"
                    data-state={
                      directory ? (directory.devices.length ? 'online' : 'unknown') : 'offline'
                    }
                    aria-hidden="true"
                  />
                  <span className="picker-provider-name mono">{provider.id}</span>
                  <span className="picker-provider-meta">
                    {directory
                      ? `${directory.devices.length} 台 · ${timeOf(directory.observedAt)} 观测`
                      : '尚无观测'}
                  </span>
                  <button
                    type="button"
                    className="picker-link"
                    disabled={pending}
                    aria-label={`重新发现 ${provider.id}`}
                    title={`重新发现 ${provider.id}`}
                    onClick={() => discover(provider)}
                  >
                    <RefreshCw aria-hidden="true" />
                    重新发现
                  </button>
                </div>
              );
            })}
          </section>
        </div>
        <aside className="picker-detail" aria-label="当前选择">
          <span className="picker-label">当前选择</span>
          {selected ? (
            <>
              <strong className="picker-detail-name">
                {selected.model ?? selected.reference.localId}
              </strong>
              <span className="picker-detail-state">
                <span className="picker-dot" data-state={selected.state} aria-hidden="true" />
                {deviceStates[selected.state]}
              </span>
              <dl className="picker-facts">
                <div>
                  <dt>平台</dt>
                  <dd className="mono">{selectedProvider?.definition.platform ?? '未知'}</dd>
                </div>
                <div>
                  <dt>标识</dt>
                  <dd className="mono">{selected.reference.localId}</dd>
                </div>
                <div>
                  <dt>提供者</dt>
                  <dd className="mono">{selected.reference.providerId}</dd>
                </div>
                <div>
                  <dt>代次</dt>
                  <dd className="mono">{selected.reference.generation}</dd>
                </div>
                <div>
                  <dt>观测</dt>
                  <dd className="mono">
                    {selectedDirectory ? timeOf(selectedDirectory.observedAt) : '—'}
                  </dd>
                </div>
              </dl>
              <span className="picker-label">能力</span>
              <div className="picker-chips" title={availableNames.join('、') || undefined}>
                {shownNames.length ? (
                  <>
                    {shownNames.map((name) => (
                      <span key={name} className="picker-chip">
                        {name}
                      </span>
                    ))}
                    {hiddenNames > 0 ? (
                      <span className="picker-chip is-idle mono">+{hiddenNames}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="picker-chip is-idle">暂无可用能力</span>
                )}
              </div>
              <Button className="picker-enter" onClick={onClose}>
                进入工作台
              </Button>
            </>
          ) : (
            <div className="picker-detail-empty">
              <PlugZap aria-hidden="true" />
              <span>先选择一台设备</span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
