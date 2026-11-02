import type { HostContext } from '@deviceforge/plugin-sdk';
import { createOperationSource, createPublicGateway } from '@deviceforge/business-kit/platform';
import type { ApiError } from '@deviceforge/business-kit/api';
import { createPerformance } from './performance/index.ts';
import { createAndroidProfile } from './android-profile/index.ts';
import type { ProfileReference } from './android-profile/index.ts';

export function createPerformanceServices(context: HostContext) {
  const devices = context.devices, artifacts = context.artifacts;
  if (!devices || !artifacts) throw new Error('性能工作区需要公开设备和产物能力');
  const operations = createOperationSource(context);
  const gateway = createPublicGateway(context);
  const performance = createPerformance(gateway);
  let observation = '';
  const errors: ApiError[] = [];
  const listeners = new Set<(errors: readonly ApiError[]) => void>();
  let cleanupSnapshot: readonly ApiError[] = [];
  const release = devices.subscribe((snapshot) => {
    const current = JSON.stringify([snapshot.selection, snapshot.selected?.state,
      snapshot.selected?.capabilities, snapshot.providers.map((provider) => [provider.id, provider.generation])]);
    if (current === observation) return;
    observation = current;
    performance.invalidateSource();
    if (snapshot.selected?.state === 'online') performance.refreshSourceObservation();
  });
  return {
    context, devices, artifacts, operations, performance, gateway,
    profile: (reference: ProfileReference) => createAndroidProfile(context, reference),
    cleanupErrors: {
      snapshot: () => cleanupSnapshot,
      subscribe(listener: (errors: readonly ApiError[]) => void) {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
    },
    reportCleanupError(error: ApiError) {
      errors.push(error);
      if (errors.length > 32) errors.shift();
      cleanupSnapshot = Object.freeze([...errors]);
      for (const listener of [...listeners]) {
        try { listener(cleanupSnapshot); } catch { /* 失败观察者不覆盖真实回收记录。 */ }
      }
    },
    dispose() { void release(); operations.dispose(); performance.dispose(); listeners.clear(); },
  };
}
export type PerformanceServices = ReturnType<typeof createPerformanceServices>;
