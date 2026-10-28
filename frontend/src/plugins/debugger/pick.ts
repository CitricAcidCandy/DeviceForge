import type { UiCollector } from './collector.ts';
import type { DebugPickResult } from './action-types.ts';
import { pluginBoundary } from './dom-evidence.ts';

export function pickOnce(collector: UiCollector, signal: AbortSignal): Promise<DebugPickResult> {
  return pickDocumentOnce(collector.root.ownerDocument, signal, (element) => collector.root.contains(element), (element) => {
    const target = collector.reference(element);
    if (target) return { status: 'picked', target, owner: collector.owner, reason: '已拦截一次点击，仅返回DOM引用和明确所有者' };
    const boundary = element.closest('[data-deviceforge-plugin], [data-deviceforge-plugin-id]');
    const identity = boundary ? pluginBoundary(boundary) : null;
    const generation = Number(identity?.generation);
    return { status: 'indeterminate', target: null,
      owner: identity?.pluginId && identity.generation !== null && Number.isSafeInteger(generation) && generation >= 0
        ? { pluginId: identity.pluginId, generation } : null,
      reason: '目标不属于当前可观测代际或已被截断；仅归属，不自动选择其他插件' };
  });
}

export function pickDocumentOnce(document: Document, signal: AbortSignal, accepts: (element: Element) => boolean,
  identify: (element: Element) => DebugPickResult): Promise<DebugPickResult> {
  return new Promise((resolve) => {
    const view = document.defaultView;
    let finished = false;
    const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown'];
    const finish = (result: DebugPickResult) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      for (const type of types) document.removeEventListener(type, intercept, true);
      resolve(result);
    };
    const cancel = () => finish({ status: 'cancelled', target: null, owner: null, reason: '拾取等待已取消' });
    const intercept = (event: Event) => {
      if (!view) return;
      if (event instanceof view.KeyboardEvent && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; }
      if (!(event.target instanceof view.Element) || event.target.closest('[data-deviceforge-debugger-internal]') || !accepts(event.target)) return;
      if (event instanceof view.KeyboardEvent && !['Enter', ' ', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type !== 'click') return;
      // 只返回精确命中的已观测节点，不将截断、其他插件或不透明后代替换为祖先。
      try {
        finish(identify(event.target));
      } catch { finish({ status: 'indeterminate', target: null, owner: null, reason: '观测扩展失败，无法归属拾取目标' }); }
    };
    const timer = setTimeout(() => finish({ status: 'indeterminate', target: null, owner: null, reason: '一次拾取超过30秒' }), 30000);
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    for (const type of types) document.addEventListener(type, intercept, true);
  });
}
