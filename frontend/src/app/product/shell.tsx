import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Smartphone, ListChecks, ChevronRight, Radio } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/Select/index.tsx';
import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { WorkspaceHeader, WorkspaceSidebar } from './chrome.tsx';
import { useAction, useSnapshot } from './hooks.ts';

export function ProductShell({
  services,
  route,
  onNavigate,
  children,
}: {
  services: ProductServices;
  route: ProductRoute;
  onNavigate(route: ProductRoute): void;
  children: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [latestJob, setLatestJob] = useState<{ operation: string; status: string } | null>(null);
  const operations = useSnapshot(services.runtime.operations);
  const devices = useSnapshot(services.runtime.devices);
  const connection = useAction();
  const discovery = useAction();
  const available = devices.directories.flatMap((directory) => directory.devices);
  const selectionKey = devices.selection ? JSON.stringify(devices.selection) : 'none';
  const selectedDevice = available.find(
    (device) => JSON.stringify(device.reference) === selectionKey,
  );
  const selectedDirectory = devices.directories.find(
    (directory) =>
      directory.provider.id === selectedDevice?.reference.providerId &&
      directory.provider.generation === selectedDevice.reference.generation,
  );
  const usableCapabilities = selectedDevice?.capabilities.filter((item) => item.available) ?? [];
  const capabilityTitles = new Map(operations.result?.data.map((item) => [item.id, item.title]));
  const connectionText = operations.pending
    ? '正在连接'
    : operations.error
      ? '服务器连接失败'
      : operations.result
        ? '服务器已连接'
        : '等待连接';
  const selectedState =
    selectedDevice?.state === 'online'
      ? '在线'
      : selectedDevice?.state === 'unauthorized'
        ? '待授权'
        : selectedDevice?.state === 'offline'
          ? '离线'
          : '状态未知';
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(preference.matches);
    const changed = () => setReduced(preference.matches);
    preference.addEventListener('change', changed);
    void connection.run(services.runtime.operations.refresh, { quiet: true });
    void discovery.run(services.runtime.devices.refreshDirectories, { quiet: true });
    return () => preference.removeEventListener('change', changed);
  }, [services]);
  useEffect(() => {
    const controller = new AbortController();
    const readLatest = () => {
      if (document.visibilityState !== 'visible') return;
      void services.runtime.tasks.list({ limit: 1 }, controller.signal).then((response) => {
        if (!controller.signal.aborted) {
          const job = response.data[0];
          setLatestJob(job ? { operation: job.operation, status: job.status } : null);
        }
      }).catch(() => {
        if (!controller.signal.aborted) setLatestJob(null);
      });
    };
    readLatest();
    const timer = window.setInterval(readLatest, 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [services]);
  function navigate(next: ProductRoute) {
    onNavigate(next);
    setDrawerOpen(false);
  }
  return (
    <div
      className={
        'product-shell' + (focused ? ' is-focused' : '') + (reduced ? ' reduce-motion' : '')
      }
      data-route={route}
      data-navigation-collapsed={collapsed}
    >
      <div className="workshop-scene" aria-hidden="true" />
      <a className="skip-link" href="#workplane">
        跳到工作区
      </a>
      <WorkspaceHeader
        route={route}
        collapsed={collapsed}
        onCollapse={() => setCollapsed((value) => !value)}
        drawerOpen={drawerOpen}
        onDrawerChange={setDrawerOpen}
        reduced={reduced}
        onReducedChange={setReduced}
        focused={focused}
        onFocusedChange={(next) => { setFocused(next); setDrawerOpen(false); }}
        connectionText={connectionText}
        connectionError={Boolean(operations.error)}
        onRefreshConnection={() => {
          void connection.run(async (signal) => {
            const result = await services.runtime.operations.refresh(signal);
            if (services.pluginDefaults.snapshot().results.some((item) => item.status === 'failed'))
              await services.pluginDefaults.retryFailures(signal);
            return result;
          }, { pending: '正在重新连接服务器…', success: null });
        }}
        onNavigate={navigate}
      />
      <WorkspaceSidebar route={route} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} onNavigate={navigate} />
      <div className="workspace-main">
        <div className="workspace-content">
          <main id="workplane" className="workplane" tabIndex={-1} data-product-workspace>
            {children}
          </main>
          <aside className="device-summary" aria-label="当前设备摘要">
            <h2>{route === 'devices' ? '设备信息' : '当前设备'}</h2>
            {route !== 'devices' && <div className="summary-device-picker">
              <Select
                value={selectionKey}
                onValueChange={(key) => {
                  const chosen = available.find(
                    (device) => JSON.stringify(device.reference) === key,
                  );
                  services.runtime.devices.select(chosen?.reference ?? null);
                }}
              >
                <SelectTrigger aria-label="选择当前设备">
                  <SelectValue placeholder="选择设备" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">尚未选择设备</SelectItem>
                  {available.map((device) => (
                    <SelectItem
                      key={JSON.stringify(device.reference)}
                      value={JSON.stringify(device.reference)}
                    >
                      {device.model ?? device.reference.localId} ·{' '}
                      {device.state === 'online'
                        ? '在线'
                        : device.state === 'unauthorized'
                          ? '待授权'
                          : device.state === 'offline'
                            ? '离线'
                            : '状态未知'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>}
            {route !== 'devices' && <div
              className={'device-summary-illustration' + (selectedDevice ? '' : ' is-empty')}
              aria-hidden="true"
            >
              <Smartphone />
            </div>}
            {selectedDevice ? (
              <>
                <h3>{selectedDevice.model ?? selectedDevice.reference.localId}</h3>
                <p className={'text-state state-' + selectedDevice.state}>
                  <Radio aria-hidden="true" />
                  {selectedState}
                </p>
                <dl className="device-summary-details">
                  <dt>平台</dt>
                  <dd>{selectedDirectory?.provider.definition.platform ?? '未知'}</dd>
                  <dt>设备 ID</dt>
                  <dd>{selectedDevice.reference.localId}</dd>
                  <dt>提供者</dt>
                  <dd>{selectedDevice.reference.providerId}</dd>
                  <dt>状态</dt>
                  <dd>{selectedState}</dd>
                  <dt>可用能力</dt>
                  <dd>{usableCapabilities.length} 项</dd>
                </dl>
                <div className="device-summary-capabilities" aria-label="设备可用能力">
                  {usableCapabilities.slice(0, 4).map((capability) => {
                    const definition = selectedDirectory?.provider.definition.capabilities.find(
                      (item) => item.id === capability.id && item.version === capability.version,
                    );
                    return (
                      <span
                        key={capability.id + ':' + capability.version}
                        title={capability.id + '@' + capability.version}
                      >
                        {definition
                          ? (capabilityTitles.get(definition.operation) ?? capability.id)
                          : capability.id}
                      </span>
                    );
                  })}
                </div>
                {route !== 'devices' && <Button variant="outline" onClick={() => navigate('devices')}>
                  进入设备工作台
                </Button>}
              </>
            ) : (
              <>
                <h3>尚未选择设备</h3>
                <p className="muted">从设备目录选择目标后，在这里查看身份、状态与可用能力。</p>
                {route === 'devices' && <dl className="device-summary-details">
                  <dt>当前状态</dt><dd>未选择</dd>
                  <dt>运行提供者</dt><dd>{devices.providers.length} 个</dd>
                  <dt>已发现设备</dt><dd>{available.length} 台</dd>
                </dl>}
                {route !== 'devices' && <Button variant="outline" onClick={() => navigate('devices')}>
                  选择设备
                </Button>}
              </>
            )}
            {route !== 'devices' && <div className="device-summary-hint">
              <ListChecks aria-hidden="true" />
              <p>任务、日志和产物会保留在工坊中，便于继续工作。</p>
            </div>}
          </aside>
        </div>
        <footer className="workspace-taskbar" aria-label="共享任务记录">
          <div>
            <ListChecks aria-hidden="true" />
            <span>任务记录</span>
            <small>{latestJob ? `${latestJob.operation} · ${latestJob.status === 'queued' ? '排队中' : latestJob.status === 'running' ? '运行中' : latestJob.status === 'succeeded' ? '已完成' : latestJob.status === 'failed' ? '失败' : '已取消'}` : '暂无任务'}</small>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate('tasks')}>
            查看全部 <ChevronRight aria-hidden="true" />
          </Button>
        </footer>
      </div>
    </div>
  );
}
