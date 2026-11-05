import type { DebugActionVerification } from './contracts.ts';
import { opaqueElement } from './dom-evidence.ts';

export type ControlExpectation =
  | { readonly condition: 'value_equals'; readonly expected: string }
  | { readonly condition: 'selected_equals'; readonly expected: readonly string[] };

// 只比较调用者本次明确提供的期望，不将控件原值加入树、日志或回执。
export function verifyControl(element: Element, expectation: ControlExpectation): DebugActionVerification {
  const unavailable = (): DebugActionVerification => ({ status: 'unavailable', scope: 'control', reason: '目标敏感、不透明、已撤销或不是支持的原生控件' });
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected || opaqueElement(element)) return unavailable();
  try {
    let matched: boolean;
    if (expectation.condition === 'value_equals') {
      if (!(element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLInputElement)) return unavailable();
      if (element instanceof view.HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(element.type)) return unavailable();
      const prototype = element instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
      const getter = Object.getOwnPropertyDescriptor(prototype, 'value')?.get;
      if (!getter) return unavailable();
      const actual: unknown = getter.call(element);
      if (typeof actual !== 'string') return unavailable();
      matched = actual === expectation.expected;
    } else {
      if (!(element instanceof view.HTMLSelectElement) || element.options.length > 500) return unavailable();
      const selected = Object.getOwnPropertyDescriptor(view.HTMLOptionElement.prototype, 'selected')?.get;
      const value = Object.getOwnPropertyDescriptor(view.HTMLOptionElement.prototype, 'value')?.get;
      if (!selected || !value) return unavailable();
      const expected = new Set(expectation.expected);
      if (expected.size !== expectation.expected.length) return unavailable();
      const actual = new Set<string>();
      let count = 0;
      for (const option of element.options) {
        const active: unknown = selected.call(option);
        if (active !== true) continue;
        const key: unknown = value.call(option);
        if (typeof key !== 'string') return unavailable();
        count++;
        actual.add(key);
      }
      matched = count === actual.size && actual.size === expected.size && [...actual].every((key) => expected.has(key));
    }
    return { status: matched ? 'passed' : 'failed', scope: 'control',
      reason: matched ? '本次期望与原生控件回读一致；不证明框架提交或业务成功' : '本次期望与原生控件回读不一致；未回显实际值' };
  } catch { return unavailable(); }
}
