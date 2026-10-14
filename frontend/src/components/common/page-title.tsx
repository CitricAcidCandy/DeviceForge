import type { ReactNode } from 'react';

export function PageTitle({eyebrow, title, description, children}: {eyebrow?: string; title: string; description?: string; children?: ReactNode}) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</header>;
}
