import type { DeviceAccess, Dispose, HostResult } from '../plugin-sdk/index.ts';

export function scopedDeviceAccess(
  upstream: DeviceAccess | undefined,
  call: <T>(request: (signal: AbortSignal) => Promise<HostResult<T>>, signal: AbortSignal) => Promise<HostResult<T>>,
  current: () => void,
  signal: AbortSignal,
  track: (release: Dispose) => Dispose,
): DeviceAccess | undefined {
  if (!upstream) return undefined;
  return Object.freeze<DeviceAccess>({
    refreshProviders: (caller) => call((combined) => upstream.refreshProviders(combined), caller),
    refreshDirectories: (caller) => call((combined) => upstream.refreshDirectories(combined), caller),
    refreshProvider: (id, generation, caller) => call((combined) => upstream.refreshProvider(id, generation, combined), caller),
    invoke: (action, caller) => call((combined) => upstream.invoke(action, combined), caller),
    select: (reference) => { current(); upstream.select(reference); },
    snapshot: () => { current(); return upstream.snapshot(); },
    subscribe: (listener) => {
      current();
      return track(upstream.subscribe((snapshot) => { if (!signal.aborted) listener(snapshot); }));
    },
  });
}
