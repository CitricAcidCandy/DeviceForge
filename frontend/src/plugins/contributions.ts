import type { PluginContributions } from '../plugin-sdk/index.ts';
import { isThemeContribution } from './themes/rules.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function array(value: unknown, check: (entry: Record<string, unknown>) => boolean): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry: unknown) => record(entry) && typeof entry.id === 'string' && check(entry),
      ))
  );
}
export function isPluginContributions(value: unknown): value is PluginContributions {
  return (
    record(value) &&
    array(value.themes, isThemeContribution) &&
    array(
      value.components,
      (entry) =>
        typeof entry.slot === 'string' &&
        typeof entry.title === 'string' &&
        typeof entry.mount === 'function' &&
        (entry.mode === undefined || entry.mode === 'append' || entry.mode === 'replace'),
    ) &&
    array(
      value.modules,
      (entry) =>
        typeof entry.route === 'string' &&
        typeof entry.title === 'string' &&
        typeof entry.mount === 'function',
    ) &&
    array(
      value.commands,
      (entry) => typeof entry.title === 'string' && typeof entry.execute === 'function',
    ) &&
    array(
      value.services,
      (entry) => typeof entry.version === 'string' && typeof entry.invoke === 'function',
    ) &&
    array(
      value.beforeTaskSubmit,
      (entry) =>
        typeof entry.transform === 'function' &&
        (entry.priority === undefined ||
          (typeof entry.priority === 'number' && Number.isSafeInteger(entry.priority))),
    )
  );
}
export function validatePluginContributions(pluginId: string, value: PluginContributions): void {
  if (!isPluginContributions(value)) throw new Error('扩展贡献结构无效');
  const ids = new Set<string>();
  const all = [
    ...(value.components ?? []),
    ...(value.modules ?? []),
    ...(value.commands ?? []),
    ...(value.services ?? []),
    ...(value.beforeTaskSubmit ?? []),
    ...(value.themes ?? []),
  ];
  for (const entry of all) {
    if (
      !entry.id.startsWith(`${pluginId}.`) ||
      !/^[a-z][a-z0-9._-]{0,199}$/.test(entry.id) ||
      ids.has(entry.id)
    )
      throw new Error('扩展贡献标识冲突或超出插件命名空间');
    ids.add(entry.id);
  }
  for (const entry of [
    ...(value.components ?? []),
    ...(value.modules ?? []),
    ...(value.commands ?? []),
  ]) {
    if (!entry.title.trim()) throw new Error('扩展入口标题不能为空');
  }
  for (const entry of value.components ?? [])
    if (!/^[a-z][a-z0-9._-]{0,199}$/.test(entry.slot)) throw new Error('组件槽位标识无效');
  for (const entry of value.modules ?? [])
    if (!entry.route.startsWith('/') || entry.route.startsWith('//') || /[?#\\]/.test(entry.route))
      throw new Error('模块路由必须为宿主路径');
  for (const entry of value.services ?? [])
    if (!entry.version.trim()) throw new Error('公开服务版本不能为空');
}
