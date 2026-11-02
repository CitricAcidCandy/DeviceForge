import { hostUi } from '@deviceforge/plugin-sdk';
import { useId } from 'react';
const { Input } = hostUi();
const { Label } = hostUi();

export function AutomationField({
  label, value, onChange, type = 'text', hint, min, max, disabled,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  type?: string;
  hint?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 content-start gap-2">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">{label}</Label>
      <Input id={id} className="w-full min-w-0" value={value} type={type} min={min} max={max} disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)} />
      {hint && <small id={`${id}-hint`} className="text-xs leading-relaxed text-faint">{hint}</small>}
    </div>
  );
}
