import { useState } from 'react';
import { ArrowUpRight, Cable, ClipboardList, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { EmptyState, PageTitle } from '../../components/index.ts';
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

type DiscoveryReport = Awaited<ReturnType<typeof discoverProviders>>['data'];

export function DevicesPage({ services }: { services: ProductServices }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const refresh = useAction();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [copyState, setCopyState] = useState('');
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
    setReport(null);
    void refresh.run((signal) =>
      services.runtime.devices.refreshProvider(provider.id, provider.generation, signal),
    );
  };
  return (
    <div className="product-page device-workspace-page" data-product-page="devices">
      <PageTitle
        eyebrow="WORKSHOP / DEVICES"
        title="设备工作台"
        description="选择设备，查看可用能力，开始你的工作。"
      >
        <Button
          variant="outline"
          disabled={refresh.pending}
          onClick={() => {
            setReport(null);
            void refresh.run(services.runtime.devices.refreshDirectories);
          }}
          title="读取服务器已有观测，不触发设备发现"
        >
          读取目录
        </Button>
        <Button
          disabled={refresh.pending}
          onClick={() => {
            setReport(null);
            void refresh.run(async (signal) => {
              const result = await discoverProviders(services.runtime.devices, signal);
              if (!signal.aborted) setReport(result.data);
              return result;
            });
          }}
        >
          <RefreshCw />
          重新发现设备
        </Button>
      </PageTitle>
      <div className="device-page-feedback">
        <ActionFeedback {...refresh} />
        {report && (
          <div className="device-discovery-report" aria-live="polite">
            <p>
              已完成 {report.discovered} 个提供者的设备发现
              {report.failures.length ? `，${report.failures.length} 个失败` : ''}。
            </p>
            {report.failures.map((failure) => (
              <p key={failure.provider}>
                {failure.provider}：{failure.message}
                {failure.logId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void Promise.resolve()
                        .then(() => navigator.clipboard.writeText(failure.logId ?? ''))
                        .then(
                          () => setCopyState('日志 ID 已复制'),
                          () => setCopyState('复制失败，请手动选择日志 ID'),
                        );
                    }}
                  >
                    复制日志 ID：{failure.logId}
                  </Button>
                )}
              </p>
            ))}
            <span role="status">{copyState}</span>
          </div>
        )}
      </div>
      <div className="device-workspace-grid">
        <DeviceDirectory
          snapshot={snapshot}
          pending={refresh.pending}
          select={services.runtime.devices.select}
          discover={discover}
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
              <span className="device-detail-icon">
                <Smartphone aria-hidden="true" />
              </span>
              <EmptyState
                title="选择一台设备开始工作"
                description={
                  snapshot.providers.length
                    ? '从左侧目录选择设备。连接或重新发现后，选择最新观测中的设备。'
                    : '先在插件页加载设备提供者，再连接或发现设备。'
                }
              />
              <div className="page-actions">
                <Button
                  onClick={() => setConnectionOpen(true)}
                  disabled={snapshot.providers.length === 0}
                >
                  <Cable />
                  连接设备
                </Button>
                <Button variant="outline" asChild>
                  <a href="#plugins">
                    管理插件
                    <ArrowUpRight />
                  </a>
                </Button>
              </div>
            </div>
          )}
          <footer className="device-observation-note">
            设备状态来自显式观测；设备断线或提供者变化后，请重新发现。任务与产物在任务记录中查询。
          </footer>
        </section>
      </div>
      <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}>
        <DialogContent className="device-connect-dialog">
          <DialogHeader>
            <DialogTitle>连接与断开设备</DialogTitle>
            <DialogDescription>
              通过当前运行的设备提供者连接地址，任务完成后刷新观测。
            </DialogDescription>
          </DialogHeader>
          {connectionOpen && (
            <DevicesConnect services={services} initialProvider={selectedProvider ?? null} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
