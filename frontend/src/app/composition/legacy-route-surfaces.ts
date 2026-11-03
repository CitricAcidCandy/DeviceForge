import type { Dispose, WorkspaceMount, WorkspaceViewContext } from '../../plugin-sdk/index.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';
import { pageSlotId } from '../../plugin-sdk/slots.ts';
import { hostSlot, slotModes } from '../product/slots.ts';
import { awaitLifecycle, defaultTimeouts } from '../../plugins/lifecycle.ts';
import { legacyWorkspacePage, legacyWorkspaceSlot } from './legacy-workspace-slots.ts';

type Extensions = PlatformRuntime['extensions'];
function slotFor(path: string): string | null {
  const module = /^\/plugin\/([^/]+)\/(.+)$/.exec(path);
  if (module) return pageSlotId(module[1] ?? '', module[2] ?? '');
  const slot = `route.${path.slice(1)}`;
  return hostSlot(slot) ? slot : null;
}

/** 仅兼容已有路由槽位；新工作区组合不依赖此旧槽位表。 */
export function legacyRouteSurfaces(resolve: () => Extensions | null, fixedSlot?: string): (mount: WorkspaceMount) => WorkspaceMount {
  return (mount) => async (target, context, instance) => {
    context.signal.throwIfAborted();
    const current = instance.snapshot(), ui = context.ui;
    const provider = current.provider, catalog = ui?.catalog();
    const page = catalog?.pages.find((entry) =>
      entry.pluginId === provider?.pluginId && entry.viewId === provider?.viewId) ??
      (ui ? legacyWorkspacePage(current, ui.snapshot()) : null);
    const slot = fixedSlot ?? (page ? slotFor(page.route)
      : legacyWorkspaceSlot(current, catalog?.views ?? []));
    const extensions = resolve();
    if (!slot || !extensions?.slots) return mount(target, context, instance);
    const document = target.ownerDocument;
    const outer = document.createElement('section'), banner = document.createElement('div');
    const additions = document.createElement('div'), fallback = document.createElement('div');
    outer.className = 'flex h-full min-h-0 min-w-0 flex-col overflow-hidden';
    outer.dataset.deviceforgeSurface = slot;
    banner.className = 'flex shrink-0 items-center justify-between gap-3 border-b border-[#E6EAF3] bg-white px-3 py-2 text-xs text-[#596479]';
    banner.hidden = true;
    additions.className = 'flex min-h-0 min-w-0 shrink-0 flex-col [&>[data-deviceforge-slot-mode=replace]]:hidden';
    additions.dataset.deviceforgeSlot = slot;
    fallback.className = 'min-h-0 min-w-0 flex-1';
    outer.append(banner, additions, fallback); target.append(outer);
    const visibility = new Set<(value: boolean) => void>();
    let replacement = false, ignored = false, closed = false, version = 0;
    let preparing: { readonly epoch: number } | null = null;
    let selected: string | null = null, releaseSlot: Dispose | null = null, releaseBase: Dispose | null = null;
    let currentAppends = new Set<string>();
    const pending = new Set<Promise<unknown>>();
    const observe = (work: Promise<unknown>) => {
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    };
    const notifyVisible = () => {
      const visible = instance.snapshot().visible && !replacement;
      for (const listener of [...visibility]) { try { listener(visible); } catch { /* 局部观察不阻断回落。 */ } }
    };
    const view: WorkspaceViewContext = {
      signal: instance.signal,
      snapshot: () => ({ ...instance.snapshot(), visible: instance.snapshot().visible && !replacement }),
      subscribeVisibility(listener) { visibility.add(listener); return () => { visibility.delete(listener); }; },
    };
    const unobserveVisibility = instance.subscribeVisibility(notifyVisible);
    const contentLayout = () => {
      fallback.hidden = replacement;
      additions.className = replacement
        ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
        : 'flex min-h-0 min-w-0 shrink-0 flex-col [&>[data-deviceforge-slot-mode=replace]]:hidden';
    };
    function status(text: string, restore: boolean) {
      banner.replaceChildren(); banner.hidden = false;
      const label = document.createElement('span'); label.textContent = text; banner.append(label);
      if (restore) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = '恢复默认';
        button.className = 'shrink-0 rounded px-2 py-1 text-[#6C4CF5]';
        button.addEventListener('click', () => { ignored = true; preparing = null; banner.hidden = true; refresh(); }); banner.append(button);
      }
    }
    const unmount = (id: string) => observe(extensions.unmount(id).catch((error: unknown) => {
      if (!closed) status(error instanceof Error ? error.message : '旧扩展回收未确认', false);
    }));
    function refresh() {
      if (closed || context.signal.aborted) return;
      const rows = extensions?.catalog().components.filter((entry) => entry.slot === slot) ?? [];
      const candidate = ignored ? null : rows.find((entry) => entry.mode === 'replace');
      const next = candidate ? `${candidate.pluginId}:${candidate.generation}:${candidate.id}` : null;
      if (selected !== next) {
        // 贡献回滚可能先于挂载拒绝；保留该次等待以显示原错，新选择或显式恢复才撤销它。
        if (next !== null || ignored) preparing = null;
        const old = selected?.split(':').slice(2).join(':');
        selected = next; const epoch = ++version;
        if (old) void unmount(old);
        replacement = false; contentLayout(); notifyVisible(); banner.hidden = true;
        if (candidate) {
          const attempt = { epoch }; preparing = attempt;
          status(`正在准备来自 ${candidate.pluginId} 的兼容视图，原内容保持可用`, true);
          void observe(extensions?.mountComponent(candidate.id).then(() => {
            if (closed || version !== epoch || context.signal.aborted) return;
            preparing = null;
            replacement = true; contentLayout(); notifyVisible();
            status(`视图来自 ${candidate.pluginId}`, true);
          }).catch((error: unknown) => {
            if (closed || context.signal.aborted || ignored || preparing !== attempt) return;
            preparing = null;
            if (error !== null && typeof error === 'object' && 'kind' in error && error.kind === 'cancelled') return;
            status(error instanceof Error ? error.message : '兼容视图加载失败，已保留原内容', true);
          }).finally(() => { if (preparing === attempt) preparing = null; }) ?? Promise.resolve());
        }
      }
      const appends = new Set(rows.filter((entry) => entry.mode === 'append').map((entry) => entry.id));
      for (const id of currentAppends) if (!appends.has(id)) void unmount(id);
      for (const id of appends) if (!currentAppends.has(id)) void observe(extensions?.mountComponent(id).catch((error: unknown) => {
        if (!closed) status(error instanceof Error ? error.message : '追加视图加载失败', false);
      }) ?? Promise.resolve());
      currentAppends = appends;
    }
    let unsubscribe: Dispose | null = null;
    let disposal: Promise<void> | null = null;
    const aborted = () => { void dispose().catch(() => undefined); };
    async function dispose() {
      if (disposal) return disposal;
      closed = true; version++; preparing = null; outer.remove();
      context.signal.removeEventListener('abort', aborted);
      void unsubscribe?.(); void unobserveVisibility(); visibility.clear();
      const owned = selected?.split(':').slice(2).join(':');
      if (owned) void unmount(owned);
      for (const id of currentAppends) void unmount(id);
      // 先撤销槽位资格，慢回收不得阻塞另一个视图定义同一兼容入口。
      const release = releaseBase; releaseBase = null;
      const slotRelease = releaseSlot; releaseSlot = null;
      disposal = awaitLifecycle(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => slotRelease?.()),
          Promise.resolve().then(() => release?.()), ...pending,
        ]);
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, '兼容视图资源回收未确认');
      }, undefined, Date.now() + defaultTimeouts.cleanupMs, '兼容路由视图回收');
      return disposal;
    }
    context.signal.addEventListener('abort', aborted, { once: true });
    try {
      const acquired = await extensions.slots.define({ id: slot, target: additions, modes: slotModes(slot) });
      if (closed || context.signal.aborted) {
        await acquired();
        context.signal.throwIfAborted();
        throw new Error('兼容路由槽位已撤销');
      }
      releaseSlot = acquired;
      context.signal.throwIfAborted();
      const release = await mount(fallback, context, view);
      if (closed || context.signal.aborted) {
        await awaitLifecycle(() => release(), undefined, Date.now() + defaultTimeouts.cleanupMs, '兼容视图晚到资源回收');
        context.signal.throwIfAborted();
        throw new Error('兼容路由视图已撤销');
      }
      releaseBase = release;
      unsubscribe = extensions.subscribe(refresh);
      refresh();
      return dispose;
    } catch (error) {
      await dispose(); throw error;
    }
  };
}
