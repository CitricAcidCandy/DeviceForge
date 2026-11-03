import { hostUi } from '@deviceforge/plugin-sdk';
import { useId } from 'react';

const { Input, Label } = hostUi();

// 字段由分析工具自身排版，不继承共享旧表单的固定宽标签列。
export function AnalysisField({ label, value, onChange, ...input }: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly placeholder?: string;
  readonly min?: number;
  readonly max?: number;
}) {
  const id = useId();
  return <div className="grid min-w-0 grid-cols-1 gap-1.5">
    <Label htmlFor={id} className="text-sm text-muted-foreground">{label}</Label>
    <Input {...input} id={id} value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}
