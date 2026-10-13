import type { ThemeContribution } from '../../plugin-sdk/index.ts';
import type { ThemeAdapter } from './types.ts';

interface SavedProperty { readonly value: string; readonly priority: string }
interface AppliedTheme {
  readonly theme: ThemeContribution;
  readonly baseline: ReadonlyMap<string, SavedProperty>;
  readonly style: HTMLStyleElement | null;
}
export function createDomThemeAdapter(target: HTMLElement): ThemeAdapter {
  let current: AppliedTheme | null = null;
  function restore(applied: AppliedTheme): void {
    applied.style?.remove();
    for (const [name, saved] of applied.baseline) {
      if (saved.value) target.style.setProperty(name, saved.value, saved.priority);
      else target.style.removeProperty(name);
    }
  }
  function install(theme: ThemeContribution): AppliedTheme {
    const values = new Map(Object.entries(theme.variables ?? {}));
    if (theme.colorScheme !== undefined) values.set('color-scheme', theme.colorScheme);
    const baseline = new Map<string, SavedProperty>();
    for (const name of values.keys()) baseline.set(name, { value: target.style.getPropertyValue(name), priority: target.style.getPropertyPriority(name) });
    const style = theme.css === undefined ? null : target.ownerDocument.createElement('style');
    if (style) { style.dataset.deviceforgeTheme = theme.id; style.textContent = theme.css ?? ''; }
    const applied: AppliedTheme = { theme, baseline, style };
    try {
      for (const [name, value] of values) target.style.setProperty(name, value, 'important');
      if (style) {
        const head = target.ownerDocument.head;
        if (!head) throw new Error('主题目标所属文档没有样式容器');
        head.append(style);
      }
      return applied;
    } catch (error) { restore(applied); throw error; }
  }
  return {
    apply(theme) {
      const previous = current;
      if (previous) restore(previous);
      current = null;
      try { if (theme) current = install(theme); }
      catch (error) {
        try { if (previous) current = install(previous.theme); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], '主题应用失败且原主题恢复失败'); }
        throw error;
      }
    },
  };
}
