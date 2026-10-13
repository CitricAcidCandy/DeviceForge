import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose, ThemeAccess, ThemeContribution, ThemeInfo, ThemeSnapshot } from '../../plugin-sdk/index.ts';
import type { ExtensionOwner } from '../extensions/types.ts';
import { copyThemeContribution } from './rules.ts';
import type { ThemeAdapter } from './types.ts';

interface OwnedTheme { readonly contribution: ThemeContribution; readonly owner: ExtensionOwner; readonly info: ThemeInfo }
export function createThemeRegistry(adapter?: ThemeAdapter) {
  const entries = new Map<string, OwnedTheme>();
  const listeners = new Set<(snapshot: ThemeSnapshot) => void>();
  let selected: OwnedTheme | null = null;
  let closed = false;
  let revision = 0;
  let notifying = false;
  let pending = false;
  function check(): void {
    if (closed) throw new HostError('cancelled', 'themes_closed', '主题注册表已关闭');
  }
  function snapshot(): ThemeSnapshot {
    check();
    return Object.freeze({ themes: Object.freeze([...entries.values()].map((entry) => entry.info)), selected: selected?.info ?? null });
  }
  function notifyListener(listener: (snapshot: ThemeSnapshot) => void, value: ThemeSnapshot): void {
    try { listener(value); } catch {}
  }
  function notify(): void {
    if (closed) return;
    revision += 1; pending = true;
    if (notifying) return;
    notifying = true;
    try {
      while (pending && !closed) {
        pending = false;
        const emitted = revision; const value = snapshot();
        for (const listener of [...listeners]) {
          if (closed || revision !== emitted) break;
          if (listeners.has(listener)) notifyListener(listener, value);
        }
      }
    } finally { notifying = false; }
  }
  function select(id: string | null): void {
    check();
    const next = id === null ? null : entries.get(id);
    if (next === undefined || next?.owner.context.signal.aborted) throw new HostError('protocol', 'theme_unavailable', '主题不存在或所属插件已撤销');
    if (next && !adapter) throw new HostError('protocol', 'theme_unavailable', '宿主没有配置主题目标');
    if (selected === next) return;
    adapter?.apply(next?.contribution ?? null);
    selected = next;
    notify();
  }
  function stage(owner: ExtensionOwner, themes: readonly ThemeContribution[]): Dispose {
    check();
    if (owner.context.signal.aborted) throw new HostError('cancelled', 'plugin_unloaded', '主题所属插件已撤销');
    const additions = themes.map(copyThemeContribution);
    const ids = additions.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => entries.has(id))) throw new Error('已登记的主题标识发生冲突');
    for (const contribution of additions) {
      const info: ThemeInfo = Object.freeze({ id: contribution.id, title: contribution.title, pluginId: owner.pluginId, generation: owner.generation,
        ...(contribution.colorScheme !== undefined ? { colorScheme: contribution.colorScheme } : {}),
      });
      entries.set(contribution.id, { contribution, owner, info });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      let removed = false;
      for (const id of ids) if (entries.delete(id)) removed = true;
      if (selected && ids.includes(selected.contribution.id)) { adapter?.apply(null); selected = null; }
      if (removed && !closed) notify();
    };
  }
  const access: ThemeAccess = Object.freeze<ThemeAccess>({
    snapshot, select,
    subscribe(listener) {
      check(); listeners.add(listener); notifyListener(listener, snapshot());
      return () => { listeners.delete(listener); };
    },
  });
  return {
    access, stage, publish: notify,
    dispose() {
      if (closed) return;
      closed = true;
      listeners.clear(); entries.clear();
      adapter?.apply(null); selected = null;
    },
  };
}
