import type { PluginInstallation } from '../types/index.ts';
import { installationCanRun } from '../utils/recovery.ts';

// 独立安装包限量恢复，单包组件顺序与失败回收仍由原激活流程负责。
export async function restoreInstallationBrowsers(
  values: readonly PluginInstallation[],
  signal: AbortSignal,
  activate: (value: PluginInstallation, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const failures: { readonly index: number; readonly reason: unknown }[] = [];
  async function next() {
    while (cursor < values.length) {
      signal.throwIfAborted();
      const index = cursor++;
      const value = values[index];
      if (!value || !installationCanRun(value)) continue;
      try { await activate(value, signal); }
      catch (reason) {
        signal.throwIfAborted();
        failures.push({ index, reason });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, next));
  signal.throwIfAborted();
  if (failures.length) throw new AggregateError(
    failures.sort((left, right) => left.index - right.index).map((failure) => failure.reason),
    '部分功能的浏览器组件恢复失败，请在已安装目录重试',
  );
}
