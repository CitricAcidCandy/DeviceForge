import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobDto } from '../../services/api/index.ts';
import type { ProductServices } from './services.ts';

export const PAGE_TASK_LIMIT = 200;

export function usePageTasks(services: ProductServices, expanded: boolean) {
  const [jobs, setJobs] = useState<readonly JobDto[]>([]);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      const response = await services.runtime.tasks.list({ limit: PAGE_TASK_LIMIT }, controller.signal);
      if (!controller.signal.aborted) {
        setJobs(response.data);
        setLoaded(true);
        setError(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError((current: unknown) => current ?? failure);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  }, [services]);
  useEffect(() => {
    void refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(visible, expanded ? 5000 : 15000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [expanded, refresh]);
  useEffect(() => () => {
    active.current?.abort();
    active.current = null;
  }, [services]);
  return { jobs, loaded, pending, error, refresh };
}
