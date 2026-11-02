import { hostUi } from '@deviceforge/plugin-sdk';
import type { ReactNode } from 'react';

export function WorkbenchDialog({ open, onOpenChange, title, description, children, actions, side = 'center' }: {
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void;
  readonly title: string; readonly description: string; readonly children: ReactNode;
  readonly actions?: ReactNode; readonly side?: 'center' | 'right';
}) {
  const { useEffect, useId, useRef } = hostUi().React;
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} onCancel={() => onOpenChange(false)} onClose={() => { if (open) onOpenChange(false); }}
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    className={hostUi().cn('fixed inset-0 max-w-none overflow-hidden border border-[#E6EAF3] bg-white p-0 text-[#222631] shadow-xl backdrop:bg-slate-900/30 open:flex open:flex-col',
      side === 'right' ? 'my-0 ml-auto mr-0 h-dvh max-h-dvh w-[min(560px,100vw)] border-r-0' : 'm-auto max-h-[90dvh] w-[min(720px,calc(100vw-2rem))] rounded-xl')}>
    <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[#E6EAF3] px-5 py-4">
      <div className="min-w-0"><h2 id={`${id}-title`} className="text-sm font-semibold">{title}</h2><p id={`${id}-description`} className="mt-1 text-xs leading-6 text-[#596479]">{description}</p></div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}<button type="button" aria-label={`关闭${title}`} onClick={() => onOpenChange(false)} className="rounded-md px-2 py-1 text-xs text-[#596479] hover:bg-[#F5F6FB]">关闭</button></div>
    </header>
    <div className="min-h-0 flex-1 overflow-auto">{open && children}</div>
  </dialog>;
}
