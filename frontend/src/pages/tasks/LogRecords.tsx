import type { TaskLookup } from '../../features/tasks/index.ts';
import { Button } from '../../components/Button/index.tsx';
import type { MessageController } from '../../components/Message/index.ts';
import { copyText } from '../../shared/clipboard/index.ts';
import type { LogOrder } from '../../services/api/index.ts';

export function LogRecords({ result, messages, order, onOrderChange }: {
  result: TaskLookup; messages: MessageController; order: LogOrder; onOrderChange(): void;
}) {
  if (!result.logs) return null;
  const { entries, limited, log_id: id } = result.logs;
  return <section className="shrink-0 space-y-2 border-b border-[color:var(--hairline)] px-5 py-4" aria-label="日志查询结果">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-[13px] font-semibold text-[color:var(--text-strong)]">请求日志 · {entries.length} 条</h2>
      <button type="button" aria-label="切换请求日志时间排序" onClick={onOrderChange}
        className="text-[12px] text-[color:var(--text-muted)] hover:text-[color:var(--primary)]">
        {order === 'desc' ? '时间倒序 ↓' : '时间升序 ↑'}
      </button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <p className="select-text break-all text-[12px] text-[color:var(--text-muted)]">{id ?? `服务器搜索：${result.query}`}</p>
      {id && <Button variant="ghost" size="sm" onClick={() => {
        void copyText(id).then((copied) => copied
          ? messages.success('日志 ID 已复制')
          : messages.warning('复制失败，请手动选择日志 ID'));
      }}>复制日志 ID</Button>}
    </div>
    {entries.length === 0 && <p className="text-[12px] text-[color:var(--text-muted)]">{id
      ? '保留日志中未找到此编号。日志可能尚未写入、已超过保留期，或来自另一个服务；请核对编号后重试。'
      : '服务器保留日志中没有匹配结果。日志可能尚未写入或已超过保留期，也可以尝试其他关键词。'}</p>}
    {entries.length > 0 && result.jobs.length === 0 && <p className="text-[12px] text-[color:var(--text-muted)]">找到请求日志，但其中没有可读取的关联任务。这不代表操作成功或失败；旧服务的查询日志可能没有记录任务编号。</p>}
    {limited && <p className="text-[12px] text-[color:var(--warning)]">本次达到扫描或返回上限，只展示部分匹配日志，结果可能不完整；可缩小查询范围后重试。</p>}
    {result.missingJobIds.length > 0 && <p className="text-[12px] text-[color:var(--text-muted)]">部分关联任务已不存在，已保留可读取的日志。</p>}
    <ol className="max-h-64 space-y-2 overflow-y-auto text-[12px] text-[color:var(--text-body)]">
      {entries.map((entry, index) => <li key={`${entry.timestamp}-${index}`} className="break-words">
        <time className="mr-2 font-mono text-[color:var(--text-ghost)]">{entry.timestamp}</time>
        <span>{entry.message}</span>
        {(entry.method || entry.route) && <span className="ml-2 font-mono">{entry.method} {entry.route}</span>}
        {entry.status != null && <span className="ml-2">请求响应 HTTP {entry.status}；不代表任务执行结果</span>}
        {entry.code && <span className="ml-2">诊断代码：{entry.code}</span>}
        {!id && entry.log_id && <div className="flex flex-wrap items-center gap-2">
          <span className="select-text break-all font-mono text-[color:var(--text-muted)]">{entry.log_id}</span>
          <button type="button" aria-label={`复制日志 ID ${entry.log_id}`}
            className="text-[color:var(--primary)] hover:underline"
            onClick={() => { if (entry.log_id) void copyText(entry.log_id).then((copied) => copied
              ? messages.success('日志 ID 已复制') : messages.warning('复制失败，请手动选择日志 ID')); }}>复制</button>
        </div>}
      </li>)}
    </ol>
  </section>;
}
