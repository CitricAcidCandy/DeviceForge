import { useEffect, useState } from 'react';
import { SettingsWaitFailure } from '../model/index.ts';
import type { SettingsServices } from '../services.ts';
import { Button, useAction } from '../view-support.tsx';
import { SettingsFailure } from './primitives.tsx';

const labels = { queued: '排队中', running: '运行中', succeeded: '调用完成，请重新读取实际配置', failed: '调用失败', cancelled: '任务已取消' };
/** 仅查询原任务，不重放写入，也不把等待取消视为后台已取消。 */
export function UnknownSettingsTask({ error, services }: { error: unknown; services: SettingsServices }) {
  const query = useAction();
  const [state, setState] = useState<string | null>(null);
  useEffect(() => { query.cancel(); setState(null); }, [error, query.cancel]);
  if (!(error instanceof SettingsWaitFailure)) return null;
  const ticket = { id: error.job.id, operation: error.job.operation, submitLogId: error.submitLogId };
  return <section className="space-y-2 rounded border border-hairline p-3 text-xs text-muted-foreground" aria-label="原配置任务查询">
    <p>当前只结束了等待，后台结果未确认。可查询原任务，不会自动重提配置写入。</p>
    <p className="break-all font-mono">{ticket.id}</p>
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" size="sm" disabled={query.pending} onClick={() => {
        void query.run(async (signal) => {
          const result = await services.settings.query(ticket, signal);
          if (!signal.aborted) setState(labels[result.data.status]);
          return result;
        });
      }}>查询原任务</Button>
      <a href="#/tasks" className="text-primary underline-offset-4 hover:underline">打开任务与日志</a>
    </div>
    {state && <p role="status">{state}</p>}
    <SettingsFailure error={query.error} logId={query.logId} />
  </section>;
}
