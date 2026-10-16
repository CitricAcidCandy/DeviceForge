import type { ComponentProps } from 'react';
import { Input } from '../Input/index.tsx';
import { FormRow } from '../Form/index.tsx';

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  placeholder,
  min,
  max,
  id,
  name,
  disabled,
  required,
  error,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  type?: string;
  hint?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  autoComplete?: ComponentProps<typeof Input>['autoComplete'];
}) {
  return (
    <FormRow
      label={label}
      required={required ?? false}
      {...(id ? { id } : {})}
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
      className="form-field"
    >
      {(controlProps) => (
        <Input
          {...controlProps}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          min={min}
          max={max}
          name={name}
          disabled={disabled}
          required={required}
          autoComplete={autoComplete}
        />
      )}
    </FormRow>
  );
}
