import type { InstallationProgress as Progress } from '../../../../features/plugin-installations/index.ts';
import { formatJobProgress } from '../../../../features/tasks/index.ts';

export function InstallationProgress({ value }: { readonly value: Progress | null }) {
  if (!value) return null;
  const progress = value.progress;
  return <div role="status" aria-live="polite" aria-label="安装任务进度">
    <p>{progress ? formatJobProgress(progress) : '正在等待安装任务状态…'}</p>
    {progress && progress.total_bytes != null && progress.total_bytes > 0 && <progress
      aria-label="当前资源进度" value={progress.completed_bytes} max={progress.total_bytes} />}
    <p>任务 ID：<code>{value.jobId}</code>{value.logId && <> · 日志 ID：<code>{value.logId}</code></>}</p>
  </div>;
}
