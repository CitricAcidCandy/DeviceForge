import type { UiNode } from './contracts.ts';
import { actionPolicy, disabledState, hiddenState } from './dom-evidence.ts';

export function mutationGuard(element: Element, node: UiNode, confirmed: boolean, allowUnknownSideEffects: boolean): string | null {
  if (node.opaque) return '不透明节点不能执行交互';
  if (hiddenState(element) !== 'no') return '目标隐藏或可见状态未知';
  if (disabledState(element) !== 'no') return '目标已禁用';
  const policy = actionPolicy(element);
  if (policy === 'device') return '调试器不自动派发真实设备动作，请通过产品确认流程操作';
  if (policy === 'read-only') return '目标声明为只读，不能执行变更动作';
  if (policy === 'unknown' && !allowUnknownSideEffects) return '目标副作用未知，需要独立授权allowUnknownSideEffects';
  if (!confirmed) return '变更动作需要调用者显式确认';
  if (element.closest('[aria-invalid="true"]')) return '目标或其容器已声明校验失败';
  if (element.localName === 'a' || element.closest('a[href]')) return '链接请通过白名单导航操作';
  if ((element.localName === 'button' && (element.getAttribute('type') ?? 'submit') === 'submit') ||
      (element.localName === 'input' && ['submit', 'image'].includes(element.getAttribute('type') ?? 'text')))
    return '不自动提交表单，请通过产品校验和确认流程操作';
  return null;
}

export function dispatchEvent(element: Element, type: string): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  return element.dispatchEvent(new view.Event(type, { bubbles: true, cancelable: true, composed: true }));
}
