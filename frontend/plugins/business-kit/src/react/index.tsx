import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { Dispose } from '@deviceforge/plugin-sdk';
import type { OperationSource } from '../platform.ts';
import { abortable } from '../api/index.ts';

export {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioItem,
  DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuSeparator,
} from './dropdown-menu.tsx';

export interface SnapshotSource<T> {
  snapshot(): T;
  subscribe(listener: (snapshot: T) => void): Dispose;
}
export function useSnapshot<T>(source: SnapshotSource<T>): T {
  const store = useMemo(() => {
    let current = source.snapshot();
    return {
      get: () => current,
      subscribe: (notify: () => void) => {
        const release = source.subscribe((next) => { current = next; notify(); });
        // 订阅建立前的提交阶段也可能完成读取；补齐这段间隔，避免永久显示旧的加载状态。
        try { current = source.snapshot(); }
        catch (error) { void release(); throw error; }
        return () => { void release(); };
      },
    };
  }, [source]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
export interface ActionOptions {
  readonly quiet?: boolean;
  readonly errorFeedback?: 'message' | 'inline';
  readonly pending?: string;
  readonly success?: string | null;
}
function logId(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  for (const field of ['logId', 'lastKnownLogId', 'submitLogId']) {
    if (field in error) {
      const value: unknown = Reflect.get(error, field);
      if (typeof value === 'string') return value;
    }
  }
  return null;
}
export function useAction() {
  const [state, setState] = useState<{ pending: boolean; error: unknown; result: unknown; logId: string | null }>({
    pending: false, error: null, result: null, logId: null,
  });
  const active = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  const cancel = useCallback(() => {
    active.current?.abort(); active.current = null;
    if (mounted.current) setState((current) => ({ ...current, pending: false }));
  }, []);
  const run = useCallback(async (action: (signal: AbortSignal) => Promise<unknown>, _options: ActionOptions = {}) => {
    active.current?.abort();
    const current = new AbortController();
    active.current = current;
    setState((previous) => ({ ...previous, pending: true, error: null }));
    try {
      const result = await abortable(action(current.signal), current.signal);
      if (mounted.current && active.current === current && !current.signal.aborted)
        setState({ pending: false, error: null, result, logId: logId(result) });
      return result;
    } catch (error) {
      if (mounted.current && active.current === current && !current.signal.aborted)
        setState((previous) => ({ ...previous, pending: false, error, logId: logId(error) }));
      return undefined;
    } finally { if (active.current === current) active.current = null; }
  }, []);
  return { ...state, run, cancel };
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const { ErrorNotice: Notice } = hostUi();
  return <Notice message={error instanceof Error ? error.message : '操作未完成，请查询真实状态'} logId={logId(error)} />;
}
export function ActionFeedback(props: { pending: boolean; error: unknown; logId: string | null; cancel(): void }) {
  const { Button } = hostUi();
  return <>
    {props.pending && <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      正在等待结果
      <Button variant="ghost" size="xs" onClick={props.cancel}>停止等待</Button>
      <span>仅停止页面等待，不代表后台任务已取消。</span>
    </div>}
    <ErrorNotice error={props.error} />
  </>;
}
export function useOperationAvailable(services: { readonly operations: OperationSource }, operation: string) {
  return useSnapshot(services.operations).result?.data.some((item) => item.id === operation) ?? false;
}
export function OperationNotice(props: { readonly services: { readonly operations: OperationSource }; readonly operation: string }) {
  const state = useSnapshot(props.services.operations);
  if (state.pending) return <p className="text-xs text-muted-foreground">正在核对能力</p>;
  return state.result?.data.some((item) => item.id === props.operation) ? null :
    <p className="text-xs text-muted-foreground">当前服务器尚未提供此功能，请加载对应插件后刷新目录。</p>;
}
