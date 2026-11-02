import { useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';

const { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } = hostUi();
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
  options, id, label, placeholder = '请选择', hint, error, className, triggerClassName,
  'aria-label': ariaLabel, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, ...props
}: SelectFieldProps) {
  const generatedId = useId(), controlId = id ?? generatedId;
  const description = [describedBy, hint ? `${controlId}-hint` : null, error ? `${controlId}-error` : null]
    .filter(Boolean).join(' ');
  return <div className={cn('grid min-w-0 gap-2', className)}>
    {label !== undefined && <Label htmlFor={controlId}>{label}{props.required && <span aria-hidden="true" className="text-destructive"> *</span>}</Label>}
    <Select {...props}>
      <SelectTrigger id={controlId} className={cn('w-full min-w-0', triggerClassName)}
        aria-label={ariaLabel} aria-describedby={description || undefined}
        aria-invalid={error ? true : ariaInvalid} aria-required={props.required}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {options.map((option) => <SelectItem key={option.value} value={option.value}
          disabled={option.disabled ?? false}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
    {hint && <small id={`${controlId}-hint`} className="text-xs text-muted-foreground">{hint}</small>}
    {error && <small id={`${controlId}-error`} role="alert" className="text-xs text-destructive">{error}</small>}
  </div>;
}
