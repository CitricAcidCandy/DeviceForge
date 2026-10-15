import { useEffect, useState } from 'react';
import { ArrowUpRight, Cable, ClipboardList, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/Dialog/index.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { capabilityGate } from '../../features/device-apps/index.ts';
import type { DeviceProviderInfo } from '../../plugin-sdk/index.ts';
import { DevicesConnect } from './components/DevicesConnect/index.tsx';
import { DeviceDirectory } from './components/DeviceDirectory/index.tsx';
import { DeviceCapabilities } from './components/DeviceCapabilities/index.tsx';
import { deviceKey, deviceStates, discoverProviders, providerKey } from './workspace.ts';
import './workspace.css';

export function DevicesPage({ services, active }: { services: ProductServices; active: boolean }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const refresh = useAction();
  const [connectionOpen, setConnectionOpen] = useState(false);
  useEffect(() => {
    if (!active) setConnectionOpen(false);
  }, [active]);
  const selected = snapshot.selected;
  const selectedProvider = snapshot.providers.find(
    (provider) =>
      selected &&
      provider.id === selected.reference.providerId &&
      provider.generation === selected.reference.generation,
  );
  const selectedDirectory = snapshot.directories.find(
    (directory) =>
      selectedProvider && providerKey(directory.provider) === providerKey(selectedProvider),
  );
  const packages = capabilityGate(
    snapshot,
    catalog.pending ? [] : (catalog.result?.data ?? []),
    'packages',
  );
  const discover = (provider: DeviceProviderInfo) => {
    void refresh.run(
      async (signal) => {
        const result = await services.runtime.devices.refreshProvider(
          provider.id,
          provider.generation,
          signal,
        );
        if (!signal.aborted)
          services.messages.success('设备发现已完成', {
            description: `${provider.definition.platform}：发现 ${result.data.devices.length} 台设备`,
            logId: result.logId,
          });
        return result;
      },
      { success: null, pending: '正在发现设备' },
    );
  };
  const discoverAll = () => {
    void refresh.run(
      async (signal) => {
        const result = await discoverProviders(services.runtime.devices, signal);
        if (!signal.aborted) {
          const title = result.data.failures.length
            ? result.data.discovered
              ? '部分设备提供者发现失败'
              : '设备发现未完成'
            : '设备发现已完成';
          const options = {
            description: `已完成 ${result.data.discovered} 个提供者的发现${result.data.failures.length ? `，${result.data.failures.length} 个失败` : ''}`,
            logId: result.logId,
            details: result.data.failures.map((failure) => ({
              label: failure.provider,
              message: failure.message,
              logId: failure.logId,
            })),
          };
          if (result.data.failures.length) services.messages.warning(title, options);
          else if (result.data.discovered === 0)
            services.messages.info('暂无运行中的设备提供者', {
              description: '在插件页启用设备提供者后重新发现。',
              logId: result.logId,
            });
          else services.messages.success(title, options);
        }
        return result;
      },
      { success: null, pending: '正在发现设备' },
    );
  };
  return (
    <section
      className="product-page device-workspace-page"
      data-product-page="devices"
      aria-label="设备工作台"
    >
      <ActionFeedback {...refresh} />
      <div className="device-workspace-grid">
        <DeviceDirectory
          snapshot={snapshot}
          pending={refresh.pending}
          select={services.runtime.devices.select}
          discover={discover}
          discoverAll={discoverAll}
          read={() => {
            void refresh.run(services.runtime.devices.refreshDirectories, {
              success: '设备目录已更新',
              pending: '正在读取设备目录',
            });
          }}
          connect={() => setConnectionOpen(true)}
        />
        <section className="device-detail-card workspace-card" aria-label="设备详细工作台">
          {selected && selectedProvider ? (
            <>
              <header className="device-detail-heading">
                <span className="device-detail-icon">
                  <Smartphone aria-hidden="true" />
                </span>
                <div>
                  <p className="eyebrow">当前工作设备</p>
                  <h2>{selected.model ?? selected.reference.localId}</h2>
                  <p>
                    <span className={`text-state state-${selected.state}`}>
                      <i aria-hidden="true" />
                      {deviceStates[selected.state]}
                    </span>
                    <span className="muted">{selectedProvider.definition.platform}</span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => services.runtime.devices.select(null)}
                >
                  取消选择
                </Button>
              </header>
              <div className="device-primary-actions">
                <Button
                  variant="secondary"
                  disabled={refresh.pending}
                  onClick={() => discover(selectedProvider)}
                >
                  <RefreshCw />
                  重新发现
                </Button>
                {packages.capability ? (
                  <Button asChild>
                    <a href="#packages">
                      <ClipboardList />
                      管理应用
                      <ArrowUpRight />
                    </a>
                  </Button>
                ) : (
                  <Button disabled title={packages.reason ?? undefined}>
                    <ClipboardList />
                    管理应用
                  </Button>
                )}
                <Button variant="outline" onClick={() => setConnectionOpen(true)}>
                  <Cable />
                  连接设备
                </Button>
              </div>
              {packages.reason && (
                <p className="device-action-hint muted">应用管理：{packages.reason}</p>
              )}
              <section className="device-information">
                <div className="device-section-heading">
                  <h3>设备信息</h3>
                  <span className="muted">来自提供者的最新观测</span>
                </div>
                <dl className="device-facts">
                  <div>
                    <dt>设备标识</dt>
                    <dd className="mono">{selected.reference.localId}</dd>
                  </div>
                  <div>
                    <dt>设备平台</dt>
                    <dd>{selectedProvider.definition.platform}</dd>
                  </div>
                  <div>
                    <dt>提供者</dt>
                    <dd>
                      {selectedProvider.id} · {selectedProvider.version}
                    </dd>
                  </div>
                  <div>
                    <dt>观测时间</dt>
                    <dd>
                      {selectedDirectory
                        ? new Date(selectedDirectory.observedAt).toLocaleString('zh-CN')
                        : '暂无观测'}
                    </dd>
                  </div>
                  {selected.rawState && (
                    <div>
                      <dt>原始状态</dt>
                      <dd>{selected.rawState}</dd>
                    </div>
                  )}
                  <div>
                    <dt>运行代次</dt>
                    <dd className="mono">{selected.reference.generation}</dd>
                  </div>
                </dl>
              </section>
              <DeviceCapabilities
                key={deviceKey(selected.reference)}
                services={services}
                device={selected}
                provider={selectedProvider}
              />
            </>
          ) : (
            <div className="device-detail-empty">
              <div className="device-empty-main">
                <span className="device-detail-icon"><Smartphone aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">下一步</p>
                  <h3>连接或选择设备</h3>
                  <p className="muted">{snapshot.providers.length
                    ? '从左侧目录选择设备；连接或重新发现后，选择最新观测中的设备。'
                    : '先在插件页启用设备提供者，再连接或发现设备。'}</p>
                </div>
                <div className="device-empty-actions">
                  <Button onClick={() => setConnectionOpen(true)} disabled={snapshot.providers.length === 0}>
                    <Cable />连接设备
                  </Button>
                  <Button variant="outline" onClick={discoverAll} disabled={refresh.pending || snapshot.providers.length === 0}>
                    <RefreshCw />重新发现
                  </Button>
                  <Button variant="ghost" asChild><a href="#plugins">管理插件<ArrowUpRight /></a></Button>
                </div>
              </div>
              <div className="device-empty-lower">
                <p>选中设备后，这里会显示可用操作和任务结果。</p>
                <a href="#tasks">查看任务记录 <ArrowUpRight aria-hidden="true" /></a>
              </div>
            </div>
          )}
        </section>
      </div>
      <Dialog open={active && connectionOpen} onOpenChange={setConnectionOpen}>
        <DialogContent className="device-connect-dialog">
          <DialogHeader>
            <DialogTitle>连接与断开设备</DialogTitle>
            <DialogDescription>
              通过当前运行的设备提供者连接地址，任务完成后刷新观测。
            </DialogDescription>
          </DialogHeader>
          {active && connectionOpen && (
            <DevicesConnect services={services} initialProvider={selectedProvider ?? null} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
