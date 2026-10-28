import type { EvidenceState, UiNode } from './contracts.ts';
import { redactText, sensitiveControl } from './privacy.ts';

export function pluginBoundary(element: Element): { pluginId: string | null; generation: string | null } {
  return { pluginId: element.getAttribute('data-deviceforge-plugin') ?? element.getAttribute('data-deviceforge-plugin-id'),
    generation: element.getAttribute('data-deviceforge-generation') };
}
export function opaqueElement(element: Element): boolean {
  return ['iframe', 'canvas', 'object', 'embed'].includes(element.localName) ||
    element.shadowRoot !== null || element.hasAttribute('data-deviceforge-opaque') ||
    element.hasAttribute('contenteditable') ||
    sensitiveControl(element);
}
export function roleOf(element: Element): string {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit.slice(0, 80);
  const tag = element.localName;
  if (tag === 'input') {
    const type = element.getAttribute('type')?.toLowerCase() ?? 'text';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (['checkbox', 'radio', 'range'].includes(type)) return type === 'range' ? 'slider' : type;
    return 'textbox';
  }
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  const roles: Readonly<Record<string, string>> = { button: 'button', textarea: 'textbox', img: 'img',
    nav: 'navigation', main: 'main', aside: 'complementary', form: 'form', dialog: 'dialog',
    ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', option: 'option' };
  return roles[tag] ?? 'generic';
}
function safeText(element: Element, root: Element, allowed: (element: Element) => boolean): string {
  const parts: string[] = [];
  let budget = 512, length = 0;
  function visit(node: Node, depth: number) {
    if (--budget < 0 || depth > 32 || length > 512) return;
    if (node.nodeType === 3) { const part = node.nodeValue?.slice(0, 256) ?? ''; parts.push(part); length += part.length; return; }
    if (node.nodeType !== 1) return;
    // 不读取表单值、可编辑文本、其他插件或不透明根的任何后代文本。
    const view = root.ownerDocument.defaultView;
    if (!view || !(node instanceof view.Element)) return;
    if (!allowed(node) || node.hasAttribute('data-deviceforge-debugger-internal')) return;
    if (['input', 'textarea', 'select', 'script', 'style', 'template'].includes(node.localName) || opaqueElement(node)) return;
    if (node !== element && pluginBoundary(node).pluginId !== null) return;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return;
    for (const child of node.childNodes) visit(child, depth + 1);
  }
  visit(element, 0);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 256);
}
export function accessibleName(element: Element, root: Element, allowed: (element: Element) => boolean): string {
  if (sensitiveControl(element)) return '';
  const label = element.getAttribute('aria-label');
  if (label) return label.slice(0, 256);
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/).slice(0, 8) ?? [];
  const labels: string[] = [];
  for (const id of ids) {
    const source = root.ownerDocument.getElementById(id);
    if (!source || !root.contains(source)) continue;
    // 引用只能沿当前目标根的同一所有权边界读取。
    let parent: Element | null = source;
    let foreign = false;
    while (parent && parent !== root) {
      if (!allowed(parent) || pluginBoundary(parent).pluginId !== null || opaqueElement(parent)) { foreign = true; break; }
      parent = parent.parentElement;
    }
    if (!foreign) labels.push(safeText(source, root, allowed));
  }
  if (labels.length) return labels.join(' ').slice(0, 256);
  if (element.localName === 'img') return element.getAttribute('alt')?.slice(0, 256) ?? '';
  if (roleOf(element) === 'generic') return '';
  return safeText(element, root, allowed);
}
export function describeHostElement(element: Element): { tag: string; role: string; label: string } {
  const root = element.ownerDocument.documentElement;
  const allowed = (node: Element) => node.closest('[data-deviceforge-plugin], [data-deviceforge-plugin-id], [data-deviceforge-debugger-internal]') === null;
  return { tag: element.localName, role: roleOf(element),
    label: allowed(element) ? redactText(accessibleName(element, root, allowed)) : '' };
}
export function hiddenState(element: Element): EvidenceState {
  if (!element.isConnected) return 'yes';
  const view = element.ownerDocument.defaultView;
  let parent: Element | null = element;
  while (parent) {
    if (parent.hasAttribute('hidden') || parent.hasAttribute('inert') || parent.getAttribute('aria-hidden') === 'true') return 'yes';
    if (view) {
      const style = view.getComputedStyle(parent);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.contentVisibility === 'hidden') return 'yes';
    }
    parent = parent.parentElement;
  }
  return view ? 'no' : 'unknown';
}
export function disabledState(element: Element): EvidenceState {
  return element.matches(':disabled') || element.closest('[aria-disabled="true"], [inert]') !== null ? 'yes' : 'no';
}
export function actionPolicy(element: Element): UiNode['actionPolicy'] {
  const policy = element.closest('[data-deviceforge-action]')?.getAttribute('data-deviceforge-action');
  return policy === 'local' || policy === 'device' || policy === 'read-only' ? policy : 'unknown';
}
