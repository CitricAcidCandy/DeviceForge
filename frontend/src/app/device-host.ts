import { HostError } from '../plugin-sdk/index.ts';
import type { DeviceAccess, Dispose } from '../plugin-sdk/index.ts';

export function createHostDeviceAccess(
  devices: DeviceAccess,
  lifetime: AbortSignal,
  track: (dispose: Dispose) => Dispose,
): DeviceAccess {
  const signal = (caller: AbortSignal) => AbortSignal.any([caller, lifetime]);
  const current = () => {
    if (lifetime.aborted) throw new HostError('cancelled', 'host_closed', '设备宿主已关闭');
  };
  return Object.freeze<DeviceAccess>({
    refreshProviders: (caller) => devices.refreshProviders(signal(caller)),
    refreshDirectories: (caller) => devices.refreshDirectories(signal(caller)),
    refreshProvider: (id, generation, caller) =>
      devices.refreshProvider(id, generation, signal(caller)),
    invoke: (action, caller) => devices.invoke(action, signal(caller)),
    select: (reference) => {
      current();
      devices.select(reference);
    },
    snapshot: () => {
      current();
      return devices.snapshot();
    },
    subscribe: (listener) => {
      current();
      return track(
        devices.subscribe((snapshot) => {
          if (!lifetime.aborted) listener(snapshot);
        }),
      );
    },
  });
}
