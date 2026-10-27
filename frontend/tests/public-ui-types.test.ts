import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentProps } from 'react';
import type { HostUi, HostUiComponentProps } from '../src/plugin-sdk/ui.ts';

// 这些函数不执行；tsconfig 必须将本文件纳入 strict，负例才有约束力。
function checkProps(ui: HostUi): void {
  const button: ComponentProps<typeof ui.Button> = { variant: 'outline', type: 'submit', onClick: (event) => event.currentTarget.focus() };
  const field: HostUiComponentProps['Field'] = { label: '名称', value: '', onChange: (value) => value.trim() };
  const select: HostUiComponentProps['Select'] = { value: 'a', onValueChange: (value) => value.toUpperCase() };
  const row: HostUiComponentProps['FormRow'] = { label: '名称', children: (control) => control.id };
  // @ts-expect-error 按钮只允许公开的变体。
  const badButton: ComponentProps<typeof ui.Button> = { variant: 'made-up' };
  // @ts-expect-error 表单字段必须提供值与变更回调。
  const badField: HostUiComponentProps['Field'] = { label: '缺少受控值' };
  // @ts-expect-error Select 的值变更是字符串，不是 DOM 事件。
  const badSelect: HostUiComponentProps['Select'] = { onValueChange: (value: Event) => value.type };
  // @ts-expect-error 步骤索引不是字符串。
  const badStepper: HostUiComponentProps['Stepper'] = { steps: [], currentStep: '1' };
  // @ts-expect-error 图表缺少必要的横轴范围、边距及无障碍名称。
  const badChart: HostUiComponentProps['MultiTrackChart'] = { tracks: [] };
  void [button, field, select, row, badButton, badField, badSelect, badStepper, badChart];
}

test('共享 UI 属性正负例由 strict 编译检查覆盖', () => {
  assert.equal(typeof checkProps, 'function');
});
