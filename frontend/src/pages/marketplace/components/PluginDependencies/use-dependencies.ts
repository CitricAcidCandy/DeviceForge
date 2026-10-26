import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../../services/api/index.ts';
import { createPluginDependencies } from '../../../../features/plugin-dependencies/index.ts';
import type {
  DependencyTarget, PluginDependenciesController, PluginDependenciesState,
} from '../../../../features/plugin-dependencies/index.ts';
import type { ApiClient } from '../../../../services/api/index.ts';

export function useDependencies(client: ApiClient, target: DependencyTarget) {
  const [controller, setController] = useState<PluginDependenciesController | null>(null);
  const [state, setState] = useState<PluginDependenciesState | null>(null);
  const [syncIssue, setSyncIssue] = useState<{ message: string; logId: string | null } | null>(null);
  const lifetime = useRef<AbortSignal | null>(null);
  useEffect(() => {
    const model = createPluginDependencies(client, { kind: target.kind, id: target.id });
    const scope = new AbortController();
    lifetime.current = scope.signal;
    setController(model);
    setState(model.snapshot());
    const unsubscribe = model.subscribe(() => { setState(model.snapshot()); });
    void model.refresh(scope.signal).catch(() => undefined);
    return () => {
      unsubscribe();
      scope.abort();
      if (lifetime.current === scope.signal) lifetime.current = null;
      model.dispose();
    };
  }, [client, target.kind, target.id]);
  const invoke = (work: (model: PluginDependenciesController, signal: AbortSignal) => Promise<void>,
    onUpdated?: (signal: AbortSignal) => Promise<void>) => {
    const signal = lifetime.current;
    if (!controller || !signal || signal.aborted) return;
    void (async () => {
      try { await work(controller, signal); } catch { return; }
      if (signal.aborted || !onUpdated) return;
      try {
        await onUpdated(signal);
        if (!signal.aborted) setSyncIssue(null);
      } catch (error) {
        if (!signal.aborted) setSyncIssue({ message: `依赖操作已完成，但安装状态同步失败：${error instanceof Error ? error.message : '请刷新市场重试'}`,
          logId: error instanceof ApiError ? error.logId : null });
      }
    })();
  };
  return { controller, state, invoke, syncIssue };
}
