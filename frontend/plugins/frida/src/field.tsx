import { useId } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';

/** 配置列自身安排标签，避免共享旧表单的固定标签列挤占输入区域。 */
export function FridaField({ label, value, onChange, ...input }: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly min?: number;
  readonly max?: number;
}) {
  const ui = hostUi(), id = useId();
  return <div className="flex min-w-0 flex-col gap-[7px]">
    <ui.Label htmlFor={id} className="text-sm text-muted-foreground">{label}</ui.Label>
    <ui.Input {...input} id={id} value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}
