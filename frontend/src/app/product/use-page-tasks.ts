import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobDto } from '../../services/api/index.ts';
import { createTaskListRefresh } from '../../features/tasks/index.ts';
import type { ProductServices } from './services.ts';

export const PAGE_TASK_LIMIT = 200;

export function usePageTasks(services: ProductServices, expanded: boolean) {
  const [jobs, setJobs] = useState<readonly JobDto[]>([]);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<ReturnType<typeof createTaskListRefresh> | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const refresh = useCallback(() => active.current?.refresh() ?? Promise.resolve(), []);
  useEffect(() => {
    const tasks = services.runtime.tasks;
    const subscribeChanges = tasks.subscribeChanges;
    let live = true;
    const next = createTaskListRefresh({
      intervalMs: expandedRef.current ? 5_000 : 15_000,
      ...(subscribeChanges ? { subscribeChanges: (listener) => subscribeChanges(listener) } : {}),
      canPoll: () => document.visibilityState === 'visible',
      read: async (signal) => {
        if (live) setPending(true);
        try {
          const response = await tasks.list({ limit: PAGE_TASK_LIMIT }, signal);
          if (!live || signal.aborted) return;
          setJobs(response.data);
          setLoaded(true);
          setError(null);
        } finally { if (live && !signal.aborted) setPending(false); }
      },
      onError: (failure) => { if (live) { setPending(false); setError((current: unknown) => current ?? failure); } },
    });
    active.current = next;
    next.start();
    const visible = () => {
      if (document.visibilityState === 'visible') void next.refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', visible);
      next.dispose();
      if (active.current === next) active.current = null;
    };
  }, [services]);
  useEffect(() => active.current?.setIntervalMs(expanded ? 5_000 : 15_000), [expanded]);
  return { jobs, loaded, pending, error, refresh };
}
