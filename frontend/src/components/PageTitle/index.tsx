import { useId, useState } from 'react';
import type { ReactNode } from 'react';

export function PageTitle({
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  const descriptionId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <header className="page-heading @container/page-title mb-6 flex min-w-0 flex-wrap items-start justify-between gap-x-5 gap-y-4 border-b border-border pb-4">
      <div className="min-w-0 flex-1 wrap-anywhere">
        <h1 className="m-0 text-[24px] leading-[1.35] font-semibold tracking-[0]">{title}</h1>
        {description && (
          <div className="page-help mt-1.5 max-w-[680px] text-[13px] text-muted-foreground">
            <button type="button" aria-expanded={helpOpen} aria-controls={descriptionId}
              className="inline-flex min-h-6 w-fit items-center gap-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ring"
              onClick={() => setHelpOpen((value) => !value)}>
              <svg viewBox="0 0 12 12" className={`size-3 shrink-0 ${helpOpen ? 'rotate-90' : ''}`} aria-hidden="true"><path d="m4 2 4 4-4 4Z" fill="currentColor" /></svg>
              使用说明
            </button>
            <p id={descriptionId} hidden={!helpOpen} className="page-description mt-2 max-w-[700px] leading-[1.7]">{description}</p>
          </div>
        )}
      </div>
      {children && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2.5 @max-[640px]/page-title:w-full [&>[data-slot=button]]:min-h-9 @max-[640px]/page-title:[&>[data-slot=button]]:min-h-11">{children}</div>}
    </header>
  );
}
