import { useId } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';

/** 采集表单保持原纵向标签，不继承通用表单的固定标签列。 */
export function CollectionField({ label, value, onChange, ...input }: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
}) {
  const ui = hostUi(), id = useId();
  return <div className="flex min-w-0 flex-col gap-[7px]">
    <ui.Label htmlFor={id} className="text-[13px] text-muted-foreground">{label}</ui.Label>
    <ui.Input {...input} id={id} value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}
