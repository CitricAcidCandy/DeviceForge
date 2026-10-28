import type { DebugActionRequest } from './contracts.ts';
import { dispatchEvent } from './action-guards.ts';

export function editControl(element: Element, request: Extract<DebugActionRequest, { type: 'fill' | 'select' }>): string | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return '目标没有可用的DOM窗口';
  if (request.type === 'fill') {
    if (request.value.length > 16384) return '填值超过16Ki字符限额';
    if (!(element instanceof view.HTMLInputElement || element instanceof view.HTMLTextAreaElement)) return '填值仅支持原生输入框或文本域';
    if (element.readOnly) return '目标只读';
    if (element instanceof view.HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(element.type))
      return '不支持密码、文件、隐藏或其他敏感类型的填值';
    if (element instanceof view.HTMLInputElement && element.type === 'number' && request.value !== '' &&
        (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(request.value) || !Number.isFinite(Number(request.value))))
      return '输入不是有效的有限数值';
    // 在空白原生控件中验证调用者输入，不读取现有控件的 value。
    const probe = element instanceof view.HTMLInputElement ? element.ownerDocument.createElement('input')
      : element.ownerDocument.createElement('textarea');
    for (const name of ['type', 'required', 'pattern', 'min', 'max', 'step', 'minlength', 'maxlength', 'multiple']) {
      const value = element.getAttribute(name);
      if (value !== null) probe.setAttribute(name, value);
    }
    probe.value = request.value;
    if (!probe.validity.valid || (request.value.length > 0 && element.minLength >= 0 && request.value.length < element.minLength) ||
        (element.maxLength >= 0 && request.value.length > element.maxLength)) return '输入未通过原生约束校验';
    const prototype = element instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return '原生填值接口不可用';
    setter.call(element, request.value);
    dispatchEvent(element, 'input'); dispatchEvent(element, 'change');
    return null;
  }
  if (!(element instanceof view.HTMLSelectElement)) return '选择仅支持原生下拉框';
  if (!request.values.length || request.values.length > 500 || (!element.multiple && request.values.length !== 1)) return '选择数量与控件类型不符';
  if (new Set(request.values).size !== request.values.length) return '选择项不能重复';
  const options = [...element.options];
  // 选择键来自调用者，按声明的 value 属性或选项标签比对，不读取当前选择值。
  const key = (option: HTMLOptionElement) => option.getAttribute('value') ?? option.textContent ?? '';
  for (const value of request.values) {
    const candidates = options.filter((option) => key(option) === value);
    if (candidates.length !== 1) return '选择项不存在或键不唯一';
    const option = candidates[0];
    if (!option || option.disabled || option.parentElement?.hasAttribute('disabled') || option.hidden) return '选择项已禁用或隐藏';
  }
  if (element.required && request.values.every((value) => value === '')) return '必选控件不能选择空项';
  for (const option of options) option.selected = request.values.includes(key(option));
  dispatchEvent(element, 'input'); dispatchEvent(element, 'change');
  return null;
}
