import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useMessage } from '../../components/Message/index.tsx';
import { ApiError } from '../../services/api/index.ts';
import { JobWaitFailure } from '../../shared/jobs/index.ts';

export interface SnapshotSource<T> {
  snapshot(): T;
  subscribe(listener: (value: T) => void): () => void;
}
export function useSnapshot<T>(source: SnapshotSource<T>): T {
  const store = useMemo(() => {
    let current = source.snapshot();
    return {
      get: () => current,
      subscribe: (notify: () => void) =>
        source.subscribe((next) => {
          current = next;
          notify();
        }),
    };
  }, [source]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
export function errorLogId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  if ('logId' in value && typeof value.logId === 'string') return value.logId;
  if ('lastKnownLogId' in value && typeof value.lastKnownLogId === 'string')
    return value.lastKnownLogId;
  if ('submitLogId' in value && typeof value.submitLogId === 'string')
    return value.submitLogId;
  return null;
}
export function isCancelledAction(value: unknown): boolean {
  if (value instanceof ApiError) return value.kind === 'cancelled';
  if (value instanceof JobWaitFailure) return isCancelledAction(value.cause);
  return value instanceof Error && value.name === 'AbortError';
}
export interface ActionOptions {
  readonly quiet?: boolean;
  readonly success?: string | null;
  readonly pending?: string;
}

export function useAction() {
  const messages = useMessage();
  const [state, setState] = useState<{
    pending: boolean;
    error: unknown;
    result: unknown;
    logId: string | null;
  }>({ pending: false, error: null, result: null, logId: null });
  const active = useRef<AbortController | null>(null);
  const notice = useRef<string | null>(null);
  const optionsRef = useRef<ActionOptions>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      if (notice.current) messages?.dismiss(notice.current);
    };
  }, [messages]);
  const cancel = useCallback(() => {
    const waiting = active.current !== null && !active.current.signal.aborted;
    active.current?.abort();
    active.current = null;
    if (notice.current) messages?.dismiss(notice.current);
    notice.current = null;
    if (waiting && mounted.current) setState((old) => ({ ...old, pending: false }));
    if (waiting && !optionsRef.current.quiet) messages?.info('已停止等待');
  }, [messages]);
  const run = useCallback(
    async (action: (signal: AbortSignal) => Promise<unknown>, options: ActionOptions = {}) => {
      active.current?.abort();
      if (notice.current) messages?.dismiss(notice.current);
      notice.current = null;
      optionsRef.current = options;
      const controller = new AbortController();
      active.current = controller;
      setState((old) => ({ ...old, pending: true, error: null }));
      if (!options.quiet)
        notice.current =
          messages?.loading(options.pending ?? '正在处理…', {
            action: { label: '取消等待', onClick: cancel },
          }) ?? null;
      try {
        const result = await action(controller.signal);
        if (mounted.current && active.current === controller && !controller.signal.aborted) {
          setState({ pending: false, error: null, result, logId: errorLogId(result) });
          if (!options.quiet && options.success !== null)
            messages?.success(options.success ?? '操作完成');
        }
      } catch (error) {
        if (mounted.current && active.current === controller && !controller.signal.aborted) {
          if (isCancelledAction(error)) {
            setState((old) => ({ ...old, pending: false, error: null }));
          } else {
            setState((old) => ({ ...old, pending: false, error, logId: errorLogId(error) }));
            messages?.error(error instanceof Error ? error.message : '操作未完成，请重试', {
              logId: errorLogId(error),
            });
          }
        }
      } finally {
        if (active.current === controller) {
          if (notice.current) messages?.dismiss(notice.current);
          notice.current = null;
          active.current = null;
          if (mounted.current) setState((old) => ({ ...old, pending: false }));
        }
      }
    },
    [messages, cancel],
  );
  return { ...state, run, cancel };
}
