import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import {
  DEVICE_SCREEN_VIEW, deviceIdentity, screenApplicationsInstance, targetReference,
} from '@deviceforge/devices/model';
import type {
  Dispose, HostContext, WebPlugin, WorkspaceMount, WorkspaceViewContext,
  WorkspaceInstance,
} from '../../plugin-sdk/index.ts';
import type { ProductPlatformServices } from './platform-services.ts';
import type { createLegacyProductAdapter } from './legacy-services.ts';

/** 仅桥接尚未迁出的画面；应用由独立插件拥有，不在此恢复旧应用实现。 */
export function createDeviceViewsBridge(services: ProductPlatformServices): WebPlugin {
  const mounts = new Set<Dispose>();
  let legacy: ReturnType<typeof createLegacyProductAdapter> | null = null;
  let occupied: symbol | null = null;
  function mount(): WorkspaceMount {
    return async (target: HTMLElement, context: HostContext, instance: WorkspaceViewContext) => {
      context.signal.throwIfAborted();
      instance.signal.throwIfAborted();
      const [{ DeviceScreen }, { createLegacyProductAdapter }] = await Promise.all([
        import('../../pages/devices/screen/index.tsx'), import('./legacy-services.ts'),
      ]);
      context.signal.throwIfAborted();
      instance.signal.throwIfAborted();
      const initial = instance.snapshot();
      const applicationInstance = screenApplicationsInstance(initial.target);
      const Composition = applicationInstance
        ? (await import('./screen-composition.tsx')).ScreenComposition : null;
      context.signal.throwIfAborted();
      instance.signal.throwIfAborted();
      const reference = targetReference(initial.target);
      const identity = deviceIdentity(reference);
      const title = '设备画面';
      // 旧媒体显示仍是单实例资源，不让第二个视图覆盖正在使用的对象。
      if (occupied)
        throw new Error(`${title}的旧实现目前只支持一个挂载实例，请先关闭原视图再重新打开`);
      legacy ??= createLegacyProductAdapter(services);
      const screenServices = legacy.services;
      const reservation = Symbol(initial.instanceId);
      const signal = AbortSignal.any([context.signal, instance.signal]);
      const root = createRoot(target);
      occupied = reservation;
      let disposed = false;
      let visible = initial.visible;
      const unsubscribe: Dispose[] = [];
      const render = () => {
        if (disposed || signal.aborted) return;
        let current: WorkspaceInstance;
        try { current = instance.snapshot(); }
        catch { return; }
        if (current.instanceId !== initial.instanceId || current.generation !== initial.generation) return;
        const snapshot = services.runtime.devices.snapshot();
        const matches = reference !== null &&
          deviceIdentity(snapshot.selection) === identity &&
          deviceIdentity(snapshot.selected?.reference ?? null) === identity;
        target.inert = !visible || !matches;
        let body: ReactNode;
        if (!reference) {
          body = <p role="status" className="px-6 py-12 text-center text-xs leading-6 text-[#596479]">
            请在设备目录选择设备。这里只展示当前工作区目标，不会自动补选或发起设备操作。
          </p>;
        } else if (!matches) {
          body = <div role="status" className="px-6 py-12 text-center">
            <p className="text-sm font-semibold text-[#222631]">设备目标已变化</p>
            <p className="mt-2 text-xs leading-6 text-[#596479]">
              当前观测与此实例的完整设备引用不一致，已停止显示交互。请重新核对工作区目标，不会自动改选设备或重放操作。
            </p>
          </div>;
        } else {
          body = Composition && applicationInstance
            ? <Composition services={screenServices} context={context} screenInstanceId={initial.instanceId} instanceId={applicationInstance} active={visible} />
            : <DeviceScreen services={screenServices} active={visible} applicationPane={false} />;
        }
        root.render(<section hidden={!visible} inert={!visible}
          ref={(element) => { if (element && !disposed) target.inert = !visible || !matches; }}
          data-device-view="screen" data-device-instance={initial.instanceId}
          data-device-generation={initial.generation} aria-label={title}
          className="h-full min-h-0 min-w-0">{body}</section>);
      };
      const dispose: Dispose = () => {
        if (disposed) return;
        disposed = true;
        mounts.delete(dispose);
        signal.removeEventListener('abort', dispose);
        for (const release of unsubscribe) void release();
        target.inert = true;
        try { root.unmount(); }
        finally {
          if (occupied === reservation) occupied = null;
        }
      };
      try {
        mounts.add(dispose);
        signal.addEventListener('abort', dispose, { once: true });
        unsubscribe.push(services.runtime.devices.subscribe(render));
        unsubscribe.push(instance.subscribeVisibility((next) => { visible = next; render(); }));
        render();
        return dispose;
      } catch (error) {
        void dispose();
        throw error;
      }
    };
  }
  return {
    id: DEVICE_SCREEN_VIEW.pluginId, version: '0.1.0', apiVersion: 2, panels: [],
    async activate(context) {
      if (!context.ui) throw new Error('旧设备视图适配需要公开工作区能力');
      context.ui.register({
        views: [
          { id: DEVICE_SCREEN_VIEW.viewId, title: '设备画面与参数', provides: ['device.screen'], mount: mount() },
        ],
      });
      context.extensions?.points?.contribute({
        id: `${DEVICE_SCREEN_VIEW.pluginId}.task-operations`,
        point: { id: 'deviceforge_devices.task-operations', version: '1' }, mode: 'append',
        data: { operations: ['runtime.status', 'record', 'open'].map((action) => `plugin.mirroring.${action}`) },
      });
      context.onDispose(async () => {
        const tasks = [...mounts].map((release) => {
          try { return Promise.resolve(release()); } catch (error) { return Promise.reject(error); }
        });
        if (legacy) tasks.push(legacy.dispose());
        const results = await Promise.allSettled(tasks);
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, '旧画面桥资源释放未确认');
      });
    },
  };
}
