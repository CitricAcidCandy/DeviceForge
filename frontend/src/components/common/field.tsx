import { useId } from 'react';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';

export function Field({label, value, onChange, type = 'text', hint, placeholder, min, max}: {label: string; value: string; onChange(value: string): void; type?: string; hint?: string; placeholder?: string; min?: number; max?: number}) {
  const id = useId();
  return <div className="form-field"><Label htmlFor={id}>{label}</Label><Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} min={min} max={max} />{hint && <small>{hint}</small>}</div>;
}
