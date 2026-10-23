import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isCancelledAction, useSnapshot } from '../../../../app/product/hooks.ts';
import { createPluginRecovery } from '../../../../features/plugin-recovery/index.ts';
import type { RecoveryTarget } from '../../../../features/plugin-recovery/index.ts';
import type { ApiClient } from '../../../../services/api/index.ts';

export function usePluginRecovery({ client, target, active, failures, blocked, onRecovered }: {
  readonly client: ApiClient;
  readonly target: RecoveryTarget | null;
  readonly active: boolean;
  readonly failures: readonly unknown[];
  readonly blocked: boolean;
  readonly onRecovered: (signal: AbortSignal) => Promise<void>;
}) {
  const recovery = useMemo(() => createPluginRecovery(client, 'mirroring'), [client]);
  const state = useSnapshot(recovery);
  const afterRecovery = useRef(onRecovered);
  const needsFailureRead = useRef(false);
  afterRecovery.current = onRecovered;
  const targetKey = target?.key ?? null;
  const deviceId = target?.deviceId ?? null;
  useEffect(() => {
    needsFailureRead.current = false;
    recovery.setTarget(active && targetKey !== null
      ? { key: targetKey, ...(deviceId === null ? {} : { deviceId }) } : null);
    if (!active || targetKey === null) return;
    void recovery.refresh(new AbortController().signal).catch(() => undefined);
    // 清空目标同时取消请求；允许 React 严格模式重新挂载同一实例。
    return () => recovery.setTarget(null);
  }, [recovery, active, targetKey, deviceId]);
  const previousFailure = useRef<{ key: string | null; failures: readonly unknown[]; blocked: boolean } | null>(null);
  const pollingDeadline = useRef<{ key: string; until: number } | null>(null);
  useEffect(() => {
    if (!active || targetKey === null) return;
    const previous = previousFailure.current;
    previousFailure.current = { key: targetKey, failures, blocked };
    const changed = previous?.key === targetKey &&
      (failures.some((failure) => failure && !isCancelledAction(failure) && !previous.failures.includes(failure)) ||
        blocked && !previous.blocked);
    if (!changed) return;
    // 失败可能晚于在途 GET 的服务端快照；收尾后最多补读一次，不抢占手动恢复。
    if (recovery.snapshot().phase === 'idle')
      void recovery.refresh(new AbortController().signal).catch(() => undefined);
    else needsFailureRead.current = true;
  }, [recovery, active, targetKey, failures, blocked]);
  useEffect(() => {
    if (active && state.phase === 'idle' && needsFailureRead.current && state.target?.key === targetKey) {
      needsFailureRead.current = false;
      void recovery.refresh(new AbortController().signal).catch(() => undefined);
    }
  }, [recovery, active, targetKey, state.phase, state.target?.key]);
  useEffect(() => {
    if (!active || targetKey === null || state.cancelled || !state.result?.data.recovering) {
      pollingDeadline.current = null;
      return;
    }
    if (pollingDeadline.current?.key !== targetKey)
      pollingDeadline.current = { key: targetKey, until: Date.now() + 40_000 };
    if (state.phase !== 'idle' || Date.now() >= pollingDeadline.current.until) return;
    // 只跟踪已经受理的恢复状态，不重复POST，也不延长服务端恢复预算。
    const timer = window.setTimeout(() => {
      void recovery.refresh(new AbortController().signal).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [recovery, active, targetKey, state.phase, state.result, state.cancelled]);
  const recover = useCallback(async (signal: AbortSignal) => {
    const admitted = recovery.snapshot().target?.key;
    const result = await recovery.recover(signal);
    if (signal.aborted || !admitted || recovery.snapshot().target?.key !== admitted) return result;
    if (result?.data.last_report?.status === 'recovered' && !result.data.cleanup_failed && !result.data.recovering)
      await afterRecovery.current(signal);
    return result;
  }, [recovery]);
  return { state, recover, refresh: recovery.refresh, prepareOpen: recovery.prepareOpen, cancel: recovery.cancel };
}
