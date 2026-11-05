import { useEffect, useState } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { Dispose, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { useSnapshot } from '@deviceforge/business-kit/react';
import { DeviceApps } from './view/packages.tsx';
import type { DeviceAppsServices } from './services.ts';

export function DeviceAppsView({ services, instance }: {
  services: DeviceAppsServices;
  instance: WorkspaceViewContext;
}) {
  useSnapshot(services.devices);
  const [visible, setVisible] = useState(instance.snapshot().visible);
  useEffect(() => {
    const release = instance.subscribeVisibility(setVisible);
    // 父视图可能在首次读取后、监听建立前切面，订阅后再核对当前事实。
    try { setVisible(instance.snapshot().visible); }
    catch (error) {
      void Promise.resolve().then(release).catch(() => {});
      throw error;
    }
    return () => { void release(); };
  }, [instance]);
  const matches = services.matchesTarget();
  return <section hidden={!visible} inert={!visible || !matches}
    data-device-view="apps" data-device-instance={instance.snapshot().instanceId}
    data-device-generation={instance.snapshot().generation} aria-label="设备应用"
    className="h-full min-h-0 min-w-0">
    {!services.reference ? (
      <p role="status" className="px-6 py-12 text-center text-xs leading-6 text-[#596479]">
        请在设备目录选择设备。这里只展示当前工作区目标，不会自动补选或发起设备操作。
      </p>
    ) : !matches ? (
      <div role="status" className="px-6 py-12 text-center">
        <p className="text-sm font-semibold text-[#222631]">设备目标已变化</p>
        <p className="mt-2 text-xs leading-6 text-[#596479]">
          当前观测与此实例的完整设备引用不一致，已停止显示交互。请重新核对工作区目标，不会自动改选设备或重放操作。
        </p>
      </div>
    ) : <DeviceApps services={services} embedded compact active={visible} />}
  </section>;
}

export function mountDeviceApps(target: HTMLElement, services: DeviceAppsServices,
  instance: WorkspaceViewContext): Dispose {
  const signal = AbortSignal.any([services.context.signal, instance.signal]);
  signal.throwIfAborted();
  const refreshInert = () => {
    target.inert = !instance.snapshot().visible || !services.matchesTarget();
  };
  refreshInert();
  const releaseReact = hostUi().mountReact(target, <DeviceAppsView services={services} instance={instance} />);
  let disposed = false;
  const unsubscribeDevices = services.devices.subscribe(refreshInert);
  const unsubscribeVisibility = instance.subscribeVisibility(refreshInert);
  try { refreshInert(); }
  catch (error) {
    target.inert = true;
    for (const release of [unsubscribeVisibility, unsubscribeDevices, releaseReact])
      void Promise.resolve().then(release).catch(() => {});
    throw error;
  }
  const dispose: Dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    void unsubscribeDevices(); void unsubscribeVisibility();
    target.inert = true;
    return releaseReact();
  };
  signal.addEventListener('abort', dispose, { once: true });
  return dispose;
}
