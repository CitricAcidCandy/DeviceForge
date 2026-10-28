import { describeHostElement } from '../../plugins/debugger/index.ts';
import type { DebugPickResult } from '../../plugins/debugger/index.ts';
import type { LocalDebuggerOptions } from './types.ts';
import { readHostRoutes } from './navigation.ts';

export function hostPick(options: LocalDebuggerOptions, element: Element): DebugPickResult {
  const declared = new Set((options.slots ?? []).map((slot) => slot.id));
  let nearestSlot: string | undefined;
  // 只沿命中目标祖先查公开锚点；普通ID、节点和面板不能形成插槽。
  for (let parent: Element | null = element; parent && nearestSlot === undefined; parent = parent.parentElement) {
    for (const attribute of ['data-deviceforge-slot', 'data-deviceforge-surface']) {
      const id = parent.getAttribute(attribute);
      if (id !== null && declared.has(id)) { nearestSlot = id; break; }
    }
  }
  const location = options.document.defaultView?.location;
  const path = location?.hash.startsWith('#/') ? location.hash.slice(1) : location?.pathname;
  const route = readHostRoutes(options).find((item) => item.path === path)?.path;
  return { status: 'picked', target: null, owner: null, source: 'host-dom',
    host: { ...describeHostElement(element), insertable: false,
      ...(nearestSlot !== undefined ? { nearest_slot: nearestSlot } : {}), ...(route !== undefined ? { route } : {}) },
    reason: nearestSlot === undefined
      ? '已拦截宿主点击，仅返回只读DOM身份；该节点没有真实公开槽位，不能插入插件'
      : '已拦截宿主点击，仅返回只读DOM身份；nearest_slot只表示公开祖先槽位，当前节点不是插入目标' };
}
