import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

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
  return value !== null &&
    typeof value === 'object' &&
    'logId' in value &&
    typeof value.logId === 'string'
    ? value.logId
    : null;
}
export function useAction() {
  const [state, setState] = useState<{
    pending: boolean;
    error: unknown;
    result: unknown;
    logId: string | null;
  }>({ pending: false, error: null, result: null, logId: null });
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const cancel = useCallback(() => {
    active.current?.abort();
  }, []);
  const run = useCallback(async (action: (signal: AbortSignal) => Promise<unknown>) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState((old) => ({ ...old, pending: true, error: null }));
    try {
      const result = await action(controller.signal);
      if (mounted.current && active.current === controller && !controller.signal.aborted)
        setState({ pending: false, error: null, result, logId: errorLogId(result) });
    } catch (error) {
      if (mounted.current && active.current === controller)
        setState((old) => ({ ...old, pending: false, error, logId: errorLogId(error) }));
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setState((old) => ({ ...old, pending: false }));
      }
    }
  }, []);
  return { ...state, run, cancel };
}
