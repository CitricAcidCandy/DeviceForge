import { useState } from 'react';
import { Check, PlugZap, RefreshCw, Search, Smartphone } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { Input } from '../../../../components/Input/index.tsx';
import { EmptyState } from '../../../../components/index.ts';
import type {
  DeviceProviderInfo,
  DeviceRef,
  DeviceSnapshot,
} from '../../../../plugin-sdk/index.ts';
import { deviceKey, deviceStates, providerKey, sameDevice } from '../../workspace.ts';

export function DeviceDirectory({
  snapshot,
  pending,
  select,
  discover,
}: {
  snapshot: DeviceSnapshot;
  pending: boolean;
  select(reference: DeviceRef): void;
  discover(provider: DeviceProviderInfo): void;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const effectiveSource = snapshot.providers.some((item) => providerKey(item) === source)
    ? source
    : '';
  const devices = snapshot.directories.flatMap((directory) =>
    directory.devices.map((device) => ({ directory, device })),
  );
  const matching = devices.filter(
    ({ directory, device }) =>
      (!effectiveSource || effectiveSource === providerKey(directory.provider)) &&
      [
        device.model ?? '',
        device.reference.localId,
        directory.provider.id,
        directory.provider.definition.platform,
      ].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  );
  return (
    <aside className="device-directory-card workspace-card" aria-label="设备目录">
      <div className="device-section-heading">
        <h2>设备目录</h2>
        <span className="device-count">{devices.length}</span>
      </div>
      <div className="device-search">
        <Search aria-hidden="true" />
        <Input
          aria-label="搜索设备"
          placeholder="搜索名称或设备标识"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <label className="device-source-filter">
        设备来源
        <select
          aria-label="筛选设备来源"
          value={effectiveSource}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="">全部提供者</option>
          {snapshot.providers.map((provider) => (
            <option value={providerKey(provider)} key={providerKey(provider)}>
              {provider.definition.platform} · {provider.id}
            </option>
          ))}
        </select>
      </label>
      <div className="device-directory-list" aria-label="已发现设备">
        {matching.map(({ directory, device }) => {
          const current = sameDevice(snapshot.selection, device.reference);
          return (
            <button
              type="button"
              key={deviceKey(device.reference)}
              className="device-directory-item"
              data-selected={current}
              data-device-reference={deviceKey(device.reference)}
              aria-pressed={current}
              aria-label={`选择设备 ${device.model ?? device.reference.localId}，${device.reference.providerId}，${device.reference.localId}`}
              onClick={() => select(device.reference)}
            >
              <span className="device-list-icon">
                <Smartphone aria-hidden="true" />
              </span>
              <span className="device-list-copy">
                <strong>{device.model ?? device.reference.localId}</strong>
                <span className={`text-state state-${device.state}`}>
                  <i aria-hidden="true" />
                  {deviceStates[device.state]}
                </span>
                <small>
                  {directory.provider.definition.platform} · {device.reference.localId}
                </small>
              </span>
              {current && <Check className="device-current-check" aria-hidden="true" />}
            </button>
          );
        })}
        {matching.length === 0 && (
          <EmptyState
            title={
              snapshot.providers.length === 0
                ? '还没有可用的设备提供者'
                : devices.length
                  ? '没有匹配的设备'
                  : '尚未发现设备'
            }
            description={
              devices.length ? '调整搜索词或设备来源。' : '连接设备后重新发现，并检查设备端授权。'
            }
          />
        )}
      </div>
      <section className="device-provider-list" aria-label="运行中的设备提供者">
        <div className="device-section-heading">
          <h3>设备提供者</h3>
          <span className="muted">{snapshot.providers.length}</span>
        </div>
        {snapshot.providers.length === 0 && (
          <p className="muted">请在插件页加载设备提供者，再读取目录。</p>
        )}
        {snapshot.providers.map((provider) => {
          const directory = snapshot.directories.find(
            (item) => providerKey(item.provider) === providerKey(provider),
          );
          return (
            <div key={providerKey(provider)} className="device-provider-item">
              <PlugZap aria-hidden="true" />
              <span>
                <strong>{provider.definition.platform}</strong>
                <small>
                  {provider.id} · {directory ? `${directory.devices.length} 台设备` : '尚无观测'}
                </small>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={pending}
                aria-label={`重新发现 ${provider.id}`}
                title={`重新发现 ${provider.id}`}
                onClick={() => discover(provider)}
              >
                <RefreshCw />
              </Button>
            </div>
          );
        })}
      </section>
    </aside>
  );
}
