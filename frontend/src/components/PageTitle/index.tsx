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
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && (
          <details className="page-help">
            <summary>使用说明</summary>
            <p className="page-description">{description}</p>
          </details>
        )}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
