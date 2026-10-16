import { useId } from 'react';
import type { ReactNode } from 'react';
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
    <div className={`form-item ${className}`}>
      <label htmlFor={controlId}>{label}{required && <span className="form-required" aria-hidden="true"> *</span>}</label>
      <div className="form-item-content">
        {typeof children === 'function' ? children(controlProps) : children}
        {hint && <small id={`${controlId}-hint`} className="form-hint">{hint}</small>}
        {error && <small id={`${controlId}-error`} className="form-error" role="alert">{error}</small>}
      </div>
    </div>
  );
}

export function FormGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`form-columns ${className}`}>{children}</div>;
}

export function FormActions({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`form-actions ${className}`}>{children}</div>;
}
