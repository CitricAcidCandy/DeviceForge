import { useEffect, useRef, useState } from 'react';
import type { PerformanceServices } from '../services.ts';
import { useSnapshot } from '@deviceforge/business-kit/react';
import type { PerformanceSession } from '../performance/index.ts';
import { captureLiveFrame, liveFrameCapability } from '../services/live-frames.ts';
import { createLiveFrames, EMPTY_LIVE_FRAMES } from '../models/live-frames.ts';

export function useLiveFrames(
  services: PerformanceServices,
  session: PerformanceSession | null,
  enabled: boolean,
  liveAvailable: boolean,
  needsReconcile: boolean,
) {
  useSnapshot(services.devices);
  useSnapshot(services.operations);
  const cleanupErrors = useSnapshot(services.cleanupErrors);
  const source = session?.source?.device;
  const reference = source ? {
    providerId: source.provider_id, generation: source.generation, localId: source.local_id,
  } : null;
  const key = JSON.stringify([session?.id, reference]);
  const store = useRef<ReturnType<typeof createLiveFrames> | null>(null);
  const [observed, setObserved] = useState({ key, snapshot: EMPTY_LIVE_FRAMES });
  const support = liveFrameCapability(services, reference);
  const permitted = enabled && session?.state === 'running' && liveAvailable &&
    !needsReconcile && support.capability !== null;

  useEffect(() => {
    const owned = reference
      ? createLiveFrames((signal) => captureLiveFrame(services, reference, signal), {
        onCleanupError: services.reportCleanupError,
      })
      : null;
    store.current = owned;
    setObserved({ key, snapshot: owned?.snapshot() ?? EMPTY_LIVE_FRAMES });
    const unwatch = owned?.subscribe((snapshot) => setObserved({ key, snapshot }));
    return () => {
      unwatch?.();
      owned?.dispose();
      if (store.current === owned) store.current = null;
    };
    // key 含完整不可变来源；指标和会话修订更新不能重建画面资源。
  }, [services, key]);
  useEffect(() => {
    if (permitted) {
      // 能力或会话恢复不重放失败请求，只有显式重试才能清除错误并继续。
      if (store.current?.snapshot().error === null) store.current.start();
    } else store.current?.pause();
    return () => store.current?.pause();
  }, [services, key, permitted]);

  return {
    ...(observed.key === key ? observed.snapshot : EMPTY_LIVE_FRAMES),
    cleanupErrors,
    available: support.capability !== null,
    unavailableReason: support.reason,
    retry() { if (permitted) store.current?.start(); },
  };
}
