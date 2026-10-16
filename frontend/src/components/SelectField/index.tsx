import { useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../utils/classnames.ts';
import { Label } from '../Label/index.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../Select/index.tsx';
import './styles.css';

export interface SelectFieldOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export type SelectFieldProps = Omit<ComponentProps<typeof Select>, 'children'> & {
  readonly options: readonly SelectFieldOption[];
  readonly id?: string;
  readonly label?: ReactNode;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
};

export function SelectField({
  options, id, label, placeholder = '请选择', hint, error, className,
  triggerClassName, 'aria-label': ariaLabel, 'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid, ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const description = [describedBy, hint ? `${controlId}-hint` : null, error ? `${controlId}-error` : null]
    .filter(Boolean).join(' ');
  return (
    <div className={cn('ui-select-field', className)}>
      {label !== undefined && <Label htmlFor={controlId}>{label}{props.required && <span className="ui-field-required" aria-hidden="true"> *</span>}</Label>}
      <Select {...props}>
        <SelectTrigger
          id={controlId}
          className={cn('ui-select-field-trigger', triggerClassName)}
          aria-label={ariaLabel}
          aria-describedby={description || undefined}
          aria-invalid={error ? true : ariaInvalid}
          aria-required={props.required}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled ?? false}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <small className="ui-field-hint" id={`${controlId}-hint`}>{hint}</small>}
      {error && <small className="ui-field-error" id={`${controlId}-error`} role="alert">{error}</small>}
    </div>
  );
}
