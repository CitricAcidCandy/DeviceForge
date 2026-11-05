import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../utils/classnames.ts';
import './styles.css';

export type FormControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
};

export function FormSection({ title, children, className = '' }: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={`form-section ${className}`}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

export function FormRow({ label, id, hint, error, children, required = false, className = '' }: {
  label: string;
  id?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode | ((props: FormControlProps) => ReactNode);
  className?: string;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = [hint ? `${controlId}-hint` : '', error ? `${controlId}-error` : '']
    .filter(Boolean)
    .join(' ');
  const controlProps: FormControlProps = {
    id: controlId,
    ...(descriptionId ? { 'aria-describedby': descriptionId } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
  };
  return (
    <div className={cn(
      'form-item @container/form-row my-3 grid min-w-0 grid-cols-[minmax(0,144px)_minmax(0,1fr)] items-start gap-x-5 gap-y-[7px]',
      '[.form-row>&]:my-0 [.form-row>&]:grid-cols-[minmax(0,1fr)] [.form-row>&]:gap-[7px] [.form-grid>&]:my-0 [.form-grid>&]:grid-cols-[minmax(0,1fr)] [.form-grid>&]:gap-[7px] [.form-columns>&]:my-0 [.form-columns>&]:grid-cols-[minmax(0,1fr)] [.form-columns>&]:gap-[7px]',
      className,
    )}>
      <label htmlFor={controlId} className="pt-2 text-sm text-muted-foreground @max-[640px]/form-row:col-span-full @max-[640px]/form-row:pt-0 [.form-row>.form-item>&]:pt-0 [.form-grid>.form-item>&]:pt-0 [.form-columns>.form-item>&]:p-0">{label}{required && <span className="form-required text-accent-warm" aria-hidden="true"> *</span>}</label>
      <div className="form-item-content flex min-w-0 max-w-[720px] flex-col items-stretch gap-[7px] @max-[640px]/form-row:col-span-full [.form-row_&]:max-w-none [.form-grid_&]:max-w-none [&>[data-slot=input]]:w-full [&>[data-slot=input]]:max-w-[480px] [&>[data-slot=select-trigger]]:w-full [&>[data-slot=select-trigger]]:max-w-[480px] [&>.inline-action]:grid [&>.inline-action]:grid-cols-[minmax(0,480px)_max-content] [&>.inline-action]:items-start [&>.inline-action]:gap-2 [&>.inline-action>[data-slot=input]]:w-full [&>.inline-action>[data-slot=input]]:min-w-0">
        {typeof children === 'function' ? children(controlProps) : children}
        {hint && <small id={`${controlId}-hint`} className="form-hint text-[13px] leading-[1.6] text-muted-foreground">{hint}</small>}
        {error && <small id={`${controlId}-error`} className="form-error" role="alert">{error}</small>}
      </div>
    </div>
  );
}

export function FormGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={cn('form-columns @container/form-grid my-4 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] items-start gap-x-6 gap-y-4 @max-[640px]/form-grid:[&>*]:col-span-full', className)}>{children}</div>;
}

export function FormActions({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`form-actions ${className}`}>{children}</div>;
}
