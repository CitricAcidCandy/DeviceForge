import type { HostContext } from '../../plugin-sdk/index.ts';
import { SHELL_POINT } from './shell-host.ts';

export function startShellSelection(
  context: HostContext,
  officialIds: ReadonlySet<string>,
  options: {
    readonly persistence?: Pick<Storage, 'getItem' | 'setItem'>;
    readonly key: string;
    readonly providerReady?: (pluginId: string, generation: number) => boolean;
  },
) {
  const points = context.extensions?.points;
  if (!points) throw new Error('平台缺少外壳扩展点');
  let preference: string | null | undefined;
  try {
    const saved = options.persistence?.getItem(options.key);
    const value: unknown = saved ? JSON.parse(saved) : undefined;
    if (value === null || typeof value === 'string') preference = value;
  } catch { /* 失效偏好不影响独立恢复入口，不自动删除原值。 */ }
  const readSelection = () => points.selection ? points.selection(SHELL_POINT) : points.selected(SHELL_POINT)?.id ?? null;
  let previous = readSelection();
  let pendingPreference = typeof preference === 'string' ? preference : null;
  let allowDefault = preference === undefined;
  let choosing = false, closed = false;
  const update = () => {
    if (closed || choosing || context.signal.aborted) return;
    const next = readSelection();
    if (previous !== next) {
      previous = next;
      pendingPreference = null;
      allowDefault = false;
      try { options.persistence?.setItem(options.key, JSON.stringify(next)); }
      catch { /* 当前会话选择继续有效，持久化失败不伪造切换失败。 */ }
      return;
    }
    // 显式选择（包括暂不可用的原意图）优先，晚到插件不能抢占。
    if (next !== null) { pendingPreference = null; allowDefault = false; return; }
    if (pendingPreference === null && !allowDefault) return;
    const choices = points.list(SHELL_POINT).filter((entry) =>
      entry.state === 'active' && entry.mode === 'replace' &&
      (!options.providerReady || options.providerReady(entry.provider.pluginId, entry.provider.generation)));
    const selected = pendingPreference !== null
      ? choices.find((entry) => entry.id === pendingPreference)
      : choices.find((entry) => officialIds.has(entry.provider.pluginId));
    if (!selected) return;
    choosing = true;
    try {
      points.select(SHELL_POINT, selected.id);
      previous = readSelection();
      pendingPreference = null;
      allowDefault = false;
    } finally { choosing = false; }
  };
  const releasePoints = points.subscribe(update);
  // 贡献可以在激活中登记；提供者真正 loaded 后才允许首次选择。
  const releaseLifecycle = context.extensions?.subscribeEvent('host.plugins.changed', update);
  update();
  return async () => {
    closed = true;
    try { await releasePoints(); }
    finally { await releaseLifecycle?.(); }
  };
}
