import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { HostError, hostUi } from '@deviceforge/plugin-sdk';
import type { HostUiComponentProps } from '@deviceforge/plugin-sdk';

export function Button(props: HostUiComponentProps['Button']) {
  const Component = hostUi().Button;
  return <Component {...props} />;
}
export function Input(props: HostUiComponentProps['Input']) {
  const Component = hostUi().Input;
  return <Component {...props} />;
}
export function EmptyState(props: HostUiComponentProps['EmptyState']) {
  const Component = hostUi().EmptyState;
  return <Component {...props} />;
}
export function JsonResult(props: HostUiComponentProps['JsonResult']) {
  const Component = hostUi().JsonResult;
  return <Component {...props} />;
}
export function cn(...values: (string | false | null | undefined)[]) {
  return values.filter(Boolean).join(' ');
}
export async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; }
  catch { return false; }
}
export function useSnapshot<T>(source: { snapshot(): T; subscribe(listener: (value: T) => void): () => void }): T {
  const store = useMemo(() => ({
    snapshot: () => source.snapshot(),
    subscribe: (notify: () => void) => source.subscribe(() => notify()),
  }), [source]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
interface ActionOptions { quiet?: boolean; success?: string | null; pending?: string }
export function useAction() {
  const [state, setState] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: null });
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, []);
  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
    if (mounted.current) setState((current) => ({ ...current, pending: false }));
  }, []);
  const run = useCallback(async (
    action: (signal: AbortSignal) => Promise<unknown>, _options: ActionOptions = {},
  ) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ pending: true, error: null });
    try { await action(controller.signal); }
    catch (error) {
      if (mounted.current && active.current === controller && !controller.signal.aborted)
        setState({ pending: false, error });
    } finally {
      if (mounted.current && active.current === controller) setState((current) => ({ ...current, pending: false }));
      if (active.current === controller) active.current = null;
    }
  }, []);
  return { ...state, run, cancel };
}
export function ActionError({ error }: { error: unknown }) {
  if (!error || (error instanceof HostError && error.kind === 'cancelled')) return null;
  const Component = hostUi().ErrorNotice;
  return <Component message={error instanceof Error ? error.message : String(error)}
    logId={error instanceof HostError ? error.logId : null} />;
}
