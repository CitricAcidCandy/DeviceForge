import type { DebugActionRequest, DebugActionResult, UiNodeRef } from './contracts.ts';
import type { UiCollector } from './collector.ts';
import type { DebugActions, DebugActionsOptions, DebugPickResult } from './action-types.ts';
import { mutationGuard } from './action-guards.ts';
import { editControl } from './form-actions.ts';
import { pickOnce } from './pick.ts';

function result(status: DebugActionResult['status'], reason: string, target: UiNodeRef | null = null): DebugActionResult {
  return { status, reason, target, businessOutcome: 'unknown' };
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
  });
}

export function createDebugActions(collector: UiCollector, options: DebugActionsOptions): DebugActions {
  const lifetime = new AbortController();
  const signal = (caller: AbortSignal) => AbortSignal.any([caller, options.signal, lifetime.signal]);
  const highlights = new Set<() => void>();
  let picking = false;
  async function execute(request: DebugActionRequest, caller: AbortSignal): Promise<DebugActionResult> {
    const current = signal(caller);
    if (current.aborted) return result('cancelled', '调试动作所属等待已撤销');
    if (request.type === 'wait') {
      const timeout = request.timeoutMs ?? 1000;
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10000) return result('rejected', '等待预算必须在0到10000毫秒之间');
      const deadline = Date.now() + timeout;
      while (!current.aborted) {
        const assertion = collector.assert(request.assertion);
        if (assertion.status === 'passed') return result('passed', assertion.reason);
        if (Date.now() >= deadline) return result('indeterminate', `等待到期：${assertion.reason}`);
        await pause(Math.min(50, Math.max(0, deadline - Date.now())), current);
      }
      return result('cancelled', '结构等待已取消');
    }
    if (request.type === 'navigate') {
      const navigate = options.navigate;
      if (!request.confirmed || !navigate || !options.allowedRoutes?.includes(request.path) ||
          !/^\/(?!\/)[^?#\\]*$/.test(request.path)) return result('rejected', '导航需要确认且只能使用宿主显式白名单内的本地路径');
      const navigation = Promise.resolve().then(() => { if (!current.aborted) return navigate(request.path, current); });
      const bounded = AbortSignal.any([current, AbortSignal.timeout(1000)]);
      try {
        await Promise.race([navigation, new Promise<never>((_, reject) => {
          const abort = () => reject(new Error('导航等待已取消或超时'));
          if (bounded.aborted) abort(); else bounded.addEventListener('abort', abort, { once: true });
          void navigation.then(() => bounded.removeEventListener('abort', abort), () => bounded.removeEventListener('abort', abort));
        })]);
        return current.aborted ? result('cancelled', '导航等待已撤销，不能推断副作用已停止') : result('dispatched', '已调用宿主导航，不保证页面或业务完成');
      } catch { return result(current.aborted ? 'cancelled' : 'indeterminate', '导航等待失败或到期，真实结果未知'); }
    }
    const target = request.target;
    const element = collector.resolve(target);
    if (!element) return result('rejected', '目标节点已更换、修订或不属于当前插件代际', target);
    const node = collector.node(target);
    if (!node) return result('indeterminate', '当前快照没有目标证据', target);
    if (request.type === 'highlight') {
      const classes = ['outline-2', 'outline-dashed', 'outline-amber-500', 'outline-offset-4'];
      const added = classes.filter((name) => !element.classList.contains(name));
      element.classList.add(...added);
      const clear = () => { clearTimeout(timer); for (const name of added) element.classList.remove(name); highlights.delete(clear); current.removeEventListener('abort', clear); };
      const timer = setTimeout(clear, 1500); highlights.add(clear); current.addEventListener('abort', clear, { once: true });
      return result('applied', '已临时添加高亮类；实际视觉效果未验', target);
    }
    const denied = mutationGuard(element, node, request.confirmed === true, request.allowUnknownSideEffects === true);
    if (denied) return result('rejected', denied, target);
    if (current.aborted || !collector.resolve(target)) return result('cancelled', '派发前目标已撤销', target);
    const view = element.ownerDocument.defaultView;
    if (!view) return result('indeterminate', '目标窗口不可用', target);
    if (request.type === 'click') {
      if (!(element instanceof view.HTMLElement)) return result('rejected', '点击仅支持原生HTML元素', target);
      element.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view }));
      return result('dispatched', '仅派发合成点击事件，不保证默认行为、框架接受或业务成功', target);
    }
    if (request.type === 'scroll') {
      if (typeof element.scrollIntoView !== 'function') return result('indeterminate', '环境不支持滚动接口', target);
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      return result('dispatched', '已请求滚动，未证明像素位置或可见性', target);
    }
    if (request.type === 'fill' || request.type === 'select') {
      const error = editControl(element, request);
      return error ? result('rejected', error, target) : result('dispatched', '已写入原生控件并派发input/change，不保证框架提交或业务成功', target);
    }
    return result('rejected', '不支持的DOM动作', target);
  }
  const dispose = () => { lifetime.abort(); for (const clear of [...highlights]) clear(); options.signal.removeEventListener('abort', dispose); };
  options.signal.addEventListener('abort', dispose, { once: true });
  if (options.signal.aborted) dispose();
  return { execute: async (request, caller) => {
    try { return await execute(request, caller); }
    catch { return result(signal(caller).aborted ? 'cancelled' : 'indeterminate', 'DOM动作无法确认，未推断业务结果'); }
  },
  async pickOnce(caller): Promise<DebugPickResult> {
    if (picking) return { status: 'indeterminate', target: null, owner: null, reason: '已有一次拾取正在等待' };
    picking = true;
    try { return await pickOnce(collector, signal(caller)); } finally { picking = false; }
  }, dispose };
}
