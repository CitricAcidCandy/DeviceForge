import { PlusIcon } from 'lucide-react';
import { cn } from '../../../../utils/classnames.ts';

export interface SessionListEntry {
  readonly id: string;
  readonly status: string;
}

/**
 * 会话栏：把实时会话记录按时间倒序列出。
 * 只负责展示与回填，不发请求；选中与新建由页面编排决定。
 */
export function SessionList({
  items,
  selectedId,
  onSelect,
  onCreate,
}: {
  items: readonly SessionListEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside
      className="hidden w-[14.5rem] shrink-0 flex-col border-r border-[color:var(--hairline)] bg-[color:var(--surface-raised)] lg:flex"
      aria-label="实时会话记录"
    >
      <div className="flex items-center justify-between gap-2 px-6 pb-2 pt-3.5">
        <h2 className="text-[11px] font-medium tracking-[0.12em] text-[color:var(--text-faint)]">
          会话
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-[color:var(--text-ghost)]">
            {items.length}
          </span>
          <button
            type="button"
            onClick={onCreate}
            aria-label="新建会话"
            className="flex size-5 items-center justify-center rounded-[4px] bg-[color:var(--surface-sunken)] text-[color:var(--text-body)] transition-colors hover:bg-[color:var(--surface-hover)]"
          >
            <PlusIcon className="size-3" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3" role="list">
        {items.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-[1.6] text-[color:var(--text-ghost)]">
            还没有实时会话记录。
          </p>
        ) : (
          items.map((item) => {
            const current = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                role="listitem"
                onClick={() => onSelect(item.id)}
                className={cn(
                  'mb-0.5 flex w-full flex-col items-start gap-1 rounded-[6px] px-2 py-2 text-left transition-colors',
                  current
                    ? 'bg-[color:var(--accent)]'
                    : 'hover:bg-[color:var(--surface-hover)]',
                )}
              >
                <span
                  className={cn(
                    'w-full truncate font-mono text-[12px]',
                    current
                      ? 'font-medium text-[color:var(--primary)]'
                      : 'text-[color:var(--text-strong)]',
                  )}
                >
                  {item.id.slice(0, 12)}
                </span>
                <span className="text-[11px] text-[color:var(--text-faint)]">{item.status}</span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
