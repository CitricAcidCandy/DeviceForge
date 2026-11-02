import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostUiComponentProps } from '@deviceforge/plugin-sdk';
import type { SettingsServices } from './services.ts';

export const Button = (props: HostUiComponentProps['Button']) => { const Component = hostUi().Button; return <Component {...props} />; };
export const Input = (props: HostUiComponentProps['Input']) => { const Component = hostUi().Input; return <Component {...props} />; };
export const Textarea = (props: HostUiComponentProps['Textarea']) => { const Component = hostUi().Textarea; return <Component {...props} />; };
export const Label = (props: HostUiComponentProps['Label']) => { const Component = hostUi().Label; return <Component {...props} />; };
export const Switch = (props: HostUiComponentProps['Switch']) => { const Component = hostUi().Switch; return <Component {...props} />; };
export const Select = (props: HostUiComponentProps['Select']) => { const Component = hostUi().Select; return <Component {...props} />; };
export const SelectTrigger = (props: HostUiComponentProps['SelectTrigger']) => { const Component = hostUi().SelectTrigger; return <Component {...props} />; };
export const SelectContent = (props: HostUiComponentProps['SelectContent']) => { const Component = hostUi().SelectContent; return <Component {...props} />; };
export const SelectValue = (props: HostUiComponentProps['SelectValue']) => { const Component = hostUi().SelectValue; return <Component {...props} />; };
export const SelectItem = (props: HostUiComponentProps['SelectItem']) => { const Component = hostUi().SelectItem; return <Component {...props} />; };
export const cn = (...values: (string | false | null | undefined)[]) => hostUi().cn(...values);
export function errorLogId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['logId', 'lastKnownLogId', 'submitLogId']) {
    if (key in value) {
      const field: unknown = Reflect.get(value, key);
      if (typeof field === 'string') return field;
    }
  }
  return null;
}
interface ActionOptions {
  readonly quiet?: boolean;
  readonly errorFeedback?: 'message' | 'inline';
  readonly success?: string | null;
}
export function useAction() {
  const [state, setState] = useState<{ pending: boolean; error: unknown; logId: string | null; result: unknown }>({
    pending: false, error: null, logId: null, result: null,
  });
  const active = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  const cancel = useCallback(() => {
    active.current?.abort();
    if (mounted.current) setState((old) => ({ ...old, pending: false }));
  }, []);
  const run = useCallback(async (request: (signal: AbortSignal) => Promise<unknown>, _options: ActionOptions = {}) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState((old) => ({ ...old, pending: true, error: null }));
    try {
      const result = await request(controller.signal);
      if (mounted.current && active.current === controller && !controller.signal.aborted)
        setState({ pending: false, error: null, logId: errorLogId(result), result });
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
export function useOperationAvailable(services: SettingsServices, operation: string): boolean {
  const operations = useSyncExternalStore(services.operations.subscribe, services.operations.snapshot, services.operations.snapshot);
  return operations.includes(operation);
}
export function OperationNotice({ services, operation }: { services: SettingsServices; operation: string }) {
  return useOperationAvailable(services, operation) ? null :
    <p role="status" className="text-[12px] leading-6 text-muted-foreground">操作目录尚未提供此功能，请启用对应服务器插件后重新读取。</p>;
}
