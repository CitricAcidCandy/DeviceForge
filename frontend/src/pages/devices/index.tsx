import { useEffect, useRef, useState } from 'react';
import { Code2, Gauge, Plus, Smartphone, Terminal } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/Dialog/index.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/Sheet/index.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import type { DeviceProviderInfo } from '../../plugin-sdk/index.ts';
import { DevicesConnect } from './components/DevicesConnect/index.tsx';
import { DeviceDirectory } from './components/DeviceDirectory/index.tsx';
import { DeviceCapabilities } from './components/DeviceCapabilities/index.tsx';
import { NoDeviceRecovery } from './components/NoDeviceRecovery/index.tsx';
import { DeviceScreen } from './screen/index.tsx';
import type { WorkbenchPane } from './screen/index.tsx';
import { deviceKey, discoverProviders, providerKey } from './workspace.ts';
import './workspace.css';

/*
 * 设备工作台：一台设备的全部工作面。
 * 画面常驻舞台，右栏在「画面参数」与「应用」之间切换——应用不再覆盖画面。
 * 设备身份与动作挂到全局顶栏，页内不再有一条只装身份的空横带。
 */
interface RailEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: typeof Smartphone;
  readonly href?: string;
  readonly onSelect?: () => void;
  readonly disabled?: boolean;
  readonly current?: boolean;
  readonly hint?: string;
}

export function DevicesPage({ services, active }: { services: ProductServices; active: boolean }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const refresh = useAction();
  const [pane, setPane] = useState<WorkbenchPane>('params');
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (!active) {
      setConnectionOpen(false);
      setDirectoryOpen(false);
      setAdvancedOpen(false);
    }
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
  const deviceTotal = snapshot.directories.reduce(
    (total, directory) => total + directory.devices.length,
    0,
  );
  // 操作目录还没到手时先退回操作 id，不能因为目录慢一拍就丢标签。
  const operationTitles = new Map(
    (catalog.result?.data ?? []).map((operation) => [operation.id, operation.title]),
  );
  const titleOf = (operation: string) => operationTitles.get(operation) ?? operation;
  /*
   * 目录里只要有一台设备就直接进工作台：空舞台只留给「真的没有设备」。
   * 只补一次初始选择——用户主动取消选择后不能再被抢回去。
   */
  const seeded = useRef(false);
  const firstAvailable = snapshot.directories.flatMap((directory) => directory.devices)[0];
  useEffect(() => {
    if (seeded.current || selected || !firstAvailable) return;
    seeded.current = true;
    services.runtime.devices.select(firstAvailable.reference);
  }, [selected, firstAvailable, services]);
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
            description: [
              `已完成 ${result.data.discovered} 个提供者的发现${result.data.failures.length ? `，${result.data.failures.length} 个失败` : ''}`,
              ...result.data.failures.map((failure) => `${failure.provider}：${failure.message}`),
            ].join('；'),
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
              description: '在市场页「已安装」启用设备提供者后重新发现。',
              logId: result.logId,
            });
          else services.messages.success(title, options);
        }
        return result;
      },
      { success: null, pending: '正在发现设备' },
    );
  };
  const rail: readonly RailEntry[] = [
    {
      id: 'directory',
      label: '设备目录',
      icon: Smartphone,
      onSelect: () => setDirectoryOpen((value) => !value),
      current: directoryOpen,
    },
    { id: 'performance', label: '性能与调用栈', icon: Gauge, href: '#performance' },
    { id: 'terminal', label: '终端', icon: Terminal, href: '#terminal' },
    {
      id: 'advanced',
      label: '能力与原始结果',
      icon: Code2,
      onSelect: () => setAdvancedOpen(true),
      disabled: !selected || !selectedProvider,
    },
  ];
  return (
    <section
      className="product-page device-workspace-page"
      data-product-page="devices"
      aria-label="设备工作台"
    >
      <ActionFeedback {...refresh} />
      {directoryOpen ? (
        <DeviceDirectory
          snapshot={snapshot}
          pending={refresh.pending}
          select={(reference) => services.runtime.devices.select(reference)}
          discover={discover}
          discoverAll={discoverAll}
          read={() => {
            void refresh.run(services.runtime.devices.refreshDirectories, {
              success: '设备目录已更新',
              pending: '正在读取设备目录',
            });
          }}
          connect={() => setConnectionOpen(true)}
          titleOf={titleOf}
          onClose={() => setDirectoryOpen(false)}
        />
      ) : (
      <div className="device-stage">
        <nav className="device-toolrail" aria-label="设备工具">
          {rail.map((entry) => {
            const Icon = entry.icon;
            if (entry.href)
              return (
                <a
                  key={entry.id}
                  className="device-rail-button"
                  href={entry.href}
                  title={entry.hint ?? entry.label}
                  aria-label={entry.label}
                  data-disabled={entry.disabled ? 'true' : undefined}
                >
                  <Icon aria-hidden="true" />
                </a>
              );
            return (
              <button
                key={entry.id}
                type="button"
                className="device-rail-button"
                onClick={entry.onSelect}
                disabled={entry.disabled ?? false}
                data-active={entry.current ? 'true' : undefined}
                title={entry.label}
                aria-label={entry.label}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
          <span className="device-rail-sep" aria-hidden="true" />
          <span
            className="device-rail-button device-rail-slot"
            title="插件工具插槽：由插件追加到此位置"
            aria-label="插件工具插槽"
          >
            <Plus aria-hidden="true" />
          </span>
        </nav>
        <div className="device-screen-area">
          {selected ? (
            <div className="device-mode-pane">
              <DeviceScreen
                services={services}
                active={active}
                pane={pane}
                onPaneChange={setPane}
              />
            </div>
          ) : (
            /* 未点亮的屏体：左右对称留白，左侧 64px 同时给工具轨让位。 */
            <div className="relative mx-16 my-3.5 flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-hairline bg-card">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-1/2 size-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary)_11%,transparent)_0%,transparent_70%)]"
              />
              <div className="relative flex max-h-full w-full max-w-[460px] flex-col items-center gap-5 overflow-y-auto px-4 py-1 text-center">
                {/* 投屏位：与真实设备框同构，设备一连上就在同一位置被填满。 */}
                <div className="flex h-[min(320px,45vh)] aspect-[150/320] shrink-0 flex-col rounded-[26px] border-[1.5px] border-dashed border-hairline-strong bg-card p-1.5">
                  <div className="relative flex flex-1 items-center justify-center rounded-[21px] bg-surface-sunken">
                    <Smartphone
                      className="size-[34px] text-ghost"
                      strokeWidth={1.3}
                      aria-hidden="true"
                    />
                    <span
                      aria-hidden="true"
                      className="absolute bottom-[9px] left-1/2 h-[3px] w-[52px] -translate-x-1/2 rounded-full bg-hairline-strong"
                    />
                  </div>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <p className="text-[18px] font-semibold text-ink">
                    {snapshot.providers.length === 0
                      ? '还没有可用的设备提供者'
                      : deviceTotal === 0
                        ? '还没有发现设备'
                        : '还没有设备进入工作台'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {snapshot.providers.length === 0
                      ? '在市场页「已安装」里启用设备提供者，再回到这里发现设备'
                      : deviceTotal === 0
                        ? '连接一台设备，或在设备目录里重新发现'
                        : `目录里已有 ${deviceTotal} 台设备，选一台开始投屏`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {snapshot.providers.length > 0 ? (
                    <Button
                      className="h-9 rounded-lg px-4"
                      onClick={() => setDirectoryOpen(true)}
                    >
                      打开设备目录
                    </Button>
                  ) : (
                    <Button className="h-9 rounded-lg px-4" asChild>
                      <a href="#marketplace">去市场页启用</a>
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="h-9 rounded-lg border-hairline bg-card px-3.5"
                    onClick={() => setConnectionOpen(true)}
                  >
                    连接设备
                  </Button>
                </div>
                <NoDeviceRecovery services={services} active={active} />
              </div>
            </div>
          )}
        </div>
      </div>
      )}
      <Sheet open={active && advancedOpen} onOpenChange={setAdvancedOpen}>
        <SheetContent side="right" className="device-drawer">
          <SheetHeader>
            <SheetTitle>{selected?.model ?? selected?.reference.localId ?? '设备能力'}</SheetTitle>
            <SheetDescription>按提供者声明调用实际能力；写入操作提交后不可回滚。</SheetDescription>
          </SheetHeader>
          {selected && selectedProvider ? (
            <>
              <dl className="device-facts">
                <div>
                  <dt>设备标识</dt>
                  <dd className="mono">{selected.reference.localId}</dd>
                </div>
                <div>
                  <dt>提供者</dt>
                  <dd className="mono">
                    {selectedProvider.id} · {selectedProvider.version}
                  </dd>
                </div>
                <div>
                  <dt>运行代次</dt>
                  <dd className="mono">{selected.reference.generation}</dd>
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
                    <dd className="mono">{selected.rawState}</dd>
                  </div>
                )}
              </dl>
              <DeviceCapabilities
                key={deviceKey(selected.reference)}
                services={services}
                device={selected}
                provider={selectedProvider}
              />
            </>
          ) : (
            <p className="muted">先选择设备。</p>
          )}
        </SheetContent>
      </Sheet>
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
