import { hostUi } from '@deviceforge/plugin-sdk';
import type { DeviceAccess, DeviceSnapshot, HostContext } from '@deviceforge/plugin-sdk';
import type { OperationSource } from '@deviceforge/business-kit/platform';
import { createDeviceAction } from './actions.ts';
import type { DeviceActionModel } from './actions.ts';
import { readDirectoryObservation, subscribeDirectoryObservation } from './directory-observation.ts';

const emptyDevices: DeviceSnapshot = { providers: [], directories: [], selection: null, selected: null };
export function useDeviceSnapshot(devices: DeviceAccess | undefined, signal: AbortSignal) {
  const { useCallback, useRef, useState, useSyncExternalStore } = hostUi().React;
  const [initial] = useState(() => devices?.snapshot() ?? emptyDevices);
  const cached = useRef(initial);
  const subscribe = useCallback((notify: () => void) => {
    if (!devices || signal.aborted) return () => {};
    const release = devices.subscribe((snapshot) => { cached.current = snapshot; notify(); });
    cached.current = devices.snapshot();
    return release;
  }, [devices, signal]);
  const read = useCallback(() => cached.current, []);
  return useSyncExternalStore(subscribe, read, read);
}
/** 提示沿用本插件公开状态订阅；挂载与读取互不等待，也不触发第二次请求。 */
export function useDirectoryObservation(context: HostContext) {
  const { useCallback, useRef, useState, useSyncExternalStore } = hostUi().React;
  const [initial] = useState(() => readDirectoryObservation(context));
  const cached = useRef(initial);
  const subscribe = useCallback((notify: () => void) => {
    if (context.signal.aborted) return () => {};
    const release = subscribeDirectoryObservation(context, () => {
      cached.current = readDirectoryObservation(context);
      notify();
    });
    cached.current = readDirectoryObservation(context);
    return release;
  }, [context]);
  const read = useCallback(() => cached.current, []);
  return useSyncExternalStore(subscribe, read, read);
}
export interface ActionScope { readonly context: HostContext; readonly model: DeviceActionModel }
/** 在效果中建立可释放资源，严格模式重挂时不用已经关闭的旧模型。 */
export function useActionScope(context: HostContext, operations: OperationSource): ActionScope | null {
  const { useEffect, useState } = hostUi().React;
  const [scope, setScope] = useState<ActionScope | null>(null);
  useEffect(() => {
    if (context.signal.aborted || !context.devices) return;
    const controller = new AbortController();
    const owned = { ...context, signal: AbortSignal.any([context.signal, controller.signal]) };
    const model = createDeviceAction(owned, operations);
    setScope({ context: owned, model });
    return () => { controller.abort(); model.dispose(); };
  }, [context, operations]);
  return scope;
}
