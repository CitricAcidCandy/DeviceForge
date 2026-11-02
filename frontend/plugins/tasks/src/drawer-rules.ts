import type { HistoricalJob, WorkspacePageInfo } from '@deviceforge/plugin-sdk';

export type TaskDockFilter = 'active' | 'failed' | 'all';
const route = (value: string) => `/${value.replace(/^#?\/?/, '').replace(/\/+$/, '')}`;

/** 默认外壳的公开哈希地址与页面目录共同决定归属，不依赖宿主业务路由表。 */
export function resolveTaskPage(pages: readonly WorkspacePageInfo[], hash: string): {
  readonly page: WorkspacePageInfo | null; readonly reason: 'missing' | 'conflict' | null;
} {
  const path = route(hash), counts = new Map<string, number>();
  for (const page of pages) counts.set(route(page.route), (counts.get(route(page.route)) ?? 0) + 1);
  if (path !== '/') {
    const matches = pages.filter((page) => route(page.route) === path);
    return matches.length > 1 ? { page: null, reason: 'conflict' }
      : matches[0] ? { page: matches[0], reason: null } : { page: null, reason: 'missing' };
  }
  const available = pages.filter((page) => counts.get(route(page.route)) === 1)
    .sort((a, b) => (a.navigation?.order ?? 100) - (b.navigation?.order ?? 100) || a.id.localeCompare(b.id));
  const first = available.find((page) => !page.navigation?.hidden) ?? available[0];
  return { page: first ?? null, reason: first ? null : 'missing' };
}

export function taskPageJobs(jobs: readonly HistoricalJob[], page: WorkspacePageInfo | null): readonly HistoricalJob[] {
  if (!page) return [];
  const operations = new Set(page.operations ?? []);
  return jobs.filter((job) => page.taskPolicy === 'all' || operations.has(job.operation))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export function filterTaskJobs(jobs: readonly HistoricalJob[], filter: TaskDockFilter): readonly HistoricalJob[] {
  return jobs.filter((job) => filter === 'all' || filter === 'failed' && job.status === 'failed' ||
    filter === 'active' && (job.status === 'running' || job.status === 'queued'));
}
