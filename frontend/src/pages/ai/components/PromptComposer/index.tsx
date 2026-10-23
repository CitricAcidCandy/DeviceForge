import { SendIcon, SquareIcon } from 'lucide-react';
import { cn } from '../../../../utils/classnames.ts';

export interface ComposerAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled: boolean;
}

/**
 * 输入区：无边框软块只装文字，动作与标签放在块外一行，
 * 避免标签和按钮挤压输入空间。
 */
export function PromptComposer({
  id,
  value,
  placeholder,
  submitLabel,
  pending,
  canSubmit,
  canCancel,
  sessionLabel,
  actions,
  onChange,
  onSubmit,
  onCancel,
}: {
  id: string;
  value: string;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  canSubmit: boolean;
  canCancel: boolean;
  sessionLabel: string;
  actions: readonly ComposerAction[];
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2.5 px-7 pb-4 pt-3">
      <div className="rounded-[10px] bg-[color:var(--surface-raised)] px-3.5 py-3">
        <label className="sr-only" htmlFor={id}>
          发给助手
        </label>
        <textarea
          id={id}
          value={value}
          rows={3}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className="block min-h-[3.5rem] w-full resize-none bg-transparent text-[15px] leading-[1.7] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-ghost)]"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {actions.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              onClick={item.onClick}
              className="rounded-[5px] px-2 py-1 text-[12px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-not-allowed disabled:text-[color:var(--text-ghost)] disabled:hover:bg-transparent"
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[color:var(--text-ghost)]">
            {sessionLabel}
          </span>
          <button
            type="button"
            disabled={!canCancel}
            onClick={onCancel}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-[6px] border px-2.5 text-[12px] font-medium transition-colors',
              canCancel
                ? 'border-[#F0D3DA] text-[color:var(--destructive)] hover:bg-[#FDECEF]'
                : 'border-[color:var(--hairline)] text-[color:var(--text-ghost)]',
            )}
          >
            <SquareIcon className="size-2.5" aria-hidden="true" />
            停止
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={onSubmit}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-[12px] font-medium transition-colors',
              canSubmit
                ? 'bg-[color:var(--primary)] text-[color:var(--primary-foreground)] hover:opacity-90'
                : 'bg-[color:var(--surface-sunken)] text-[color:var(--text-ghost)]',
            )}
          >
            <SendIcon className="size-3" aria-hidden="true" />
            {pending ? '发送中…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
