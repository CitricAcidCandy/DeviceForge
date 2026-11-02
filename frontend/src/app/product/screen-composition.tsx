import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Dispose, HostContext, UiAccess } from '../../plugin-sdk/index.ts';
import { DeviceScreen } from '../../pages/devices/screen/index.tsx';
import type { WorkbenchPane } from '../../pages/devices/screen/index.tsx';
import type { ProductServices } from './services.ts';
import { DEVICE_WORKBENCH_PANE_EVENT } from '@deviceforge/devices/model';

/** 只负责组合位置和可见性；应用业务由独立提供者通过公开挂载管线实现。 */
export function ScreenComposition({ services, context, screenInstanceId, instanceId, active }: {
  readonly services: ProductServices;
  readonly context: HostContext;
  readonly screenInstanceId: string;
  readonly instanceId: string;
  readonly active: boolean;
}) {
  const ui = context.ui;
  if (!ui?.mount) throw new Error('设备工作台需要公开工作区挂载能力');
  return <ComposedScreen services={services} context={context} ui={ui} screenInstanceId={screenInstanceId} instanceId={instanceId} active={active} />;
}
function ComposedScreen({ services, context, ui, screenInstanceId, instanceId, active }: {
  readonly services: ProductServices; readonly context: HostContext; readonly ui: UiAccess;
  readonly instanceId: string; readonly active: boolean;
  readonly screenInstanceId: string;
}) {
  const [pane, setPane] = useState<WorkbenchPane>('params');
  const [opened, setOpened] = useState(false);
  const cached = useRef(ui.snapshot());
  const revision = () => {
    if (!context.signal.aborted) cached.current = ui.snapshot();
    return cached.current.revision;
  };
  useSyncExternalStore(ui.subscribe, revision, revision);
  const instance = cached.current.instances.find((entry) => entry.instanceId === instanceId);
  const available = instance?.state === 'ready';
  useEffect(() => {
    const release = context.extensions?.subscribeEvent(DEVICE_WORKBENCH_PANE_EVENT, (event) => {
      const data = event.data;
      if (context.signal.aborted || !data || typeof data !== 'object' || Array.isArray(data) ||
          data.screenInstanceId !== screenInstanceId || data.pane !== 'apps' && data.pane !== 'params') return;
      setPane(data.pane);
      if (data.pane === 'apps') setOpened(true);
    });
    return () => { void release?.(); };
  }, [context, screenInstanceId]);
  useLayoutEffect(() => {
    if (context.signal.aborted || !instance) return;
    const visible = active && pane === 'apps';
    if (instance.visible !== visible) ui.setVisible(instanceId, visible);
  }, [context, ui, instanceId, instance?.generation, instance?.visible, active, pane]);
  return <DeviceScreen services={services} active={active} pane={pane} onPaneChange={(next) => {
    setPane(next);
    if (next === 'apps') setOpened(true);
  }} applicationAvailable={available} applicationContent={<ApplicationInstance context={context} ui={ui}
    instanceId={instanceId} generation={instance?.generation ?? null} available={available} opened={opened} />} />;
}
function ApplicationInstance({ context, ui, instanceId, generation, available, opened }: {
  readonly context: HostContext; readonly ui: UiAccess; readonly instanceId: string;
  readonly generation: number | null; readonly available: boolean; readonly opened: boolean;
}) {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    const element = target.current, mount = ui.mount;
    if (!opened || !available || !element || !mount || context.signal.aborted) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let release: Dispose | null = null;
    setError(null);
    // 原公开挂载管线拥有就绪等待和期限，适配层不随通知取消或重放同一次挂载。
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return mount(instanceId, element, signal);
    }).then((dispose) => {
      if (signal.aborted) { void Promise.resolve().then(dispose).catch(() => {}); return; }
      release = dispose;
    }, (failure: unknown) => {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : '应用插件暂时无法显示');
    });
    return () => {
      controller.abort();
      // 清理失败由原挂载管线记录；切换页签不执行本清理，不丢应用草稿。
      if (release) void Promise.resolve().then(release).catch(() => {});
    };
  }, [context, ui, instanceId, generation, available, opened, retry]);
  return <div className="h-full min-h-0 min-w-0" data-device-applications-instance={instanceId}>
    <div ref={target} hidden={!available || Boolean(error)} className="h-full min-h-0 min-w-0" />
    {(!available || error) && <div className="p-4 text-xs leading-6 text-[#596479]" role={error ? 'alert' : 'status'}>
      <p>{available ? error : '应用插件暂不可用，画面与参数仍可使用。'}</p>
      {available && error && <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 text-[#6C4CF5]">重新打开应用</button>}
    </div>}
  </div>;
}
