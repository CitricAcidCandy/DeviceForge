import { ApiError } from '@deviceforge/plugin-sdk';
import type { MarketplaceServices } from '../services.ts';
import { packagesEndpoint, installationsEndpoint } from '../api/index.ts';
import type { ImportedPluginDebugTarget } from './types.ts';

export function localImportDebugUnavailableReason(services: MarketplaceServices): string | null {
  return services.context.services?.catalog().some((entry) =>
    entry.service.id === 'host.debugger' && entry.service.version === '1' && entry.available)
    ? null : '当前连接未提供可用调试器；请使用本机连接并在已安装列表启用调试器后重试。';
}
/** 只带入本次导入目标；不启用被测插件、不打开执行会话。 */
export async function openImportedPluginDebugger(services: MarketplaceServices, target: ImportedPluginDebugTarget, caller: AbortSignal) {
  const signal = AbortSignal.any([caller, services.context.signal]);
  signal.throwIfAborted();
  const unavailable = localImportDebugUnavailableReason(services);
  if (unavailable) throw new Error(unavailable);
  if (!target.candidates.length) throw new Error('本次导入没有可调试插件组件，请查询实际安装目录');
  if (target.installation) {
    const directory = await services.client.call(installationsEndpoint, undefined, signal);
    signal.throwIfAborted();
    const current = directory.data.find((entry) => entry.id === target.installation?.id);
    if (!current || current.revision !== target.installation.revision || target.candidates.some((candidate) =>
      !current.components.some((component) => component.id === candidate.id && component.kind === candidate.kind && component.version === candidate.version)))
      throw new ApiError('protocol', 'import_debug_target_changed', '导入后插件已更新或移除，请核对当前版本再调试；无需重复导入', null, directory.logId);
  } else {
    for (const kind of new Set(target.candidates.map((candidate) => candidate.kind))) {
      const directory = await services.client.call(packagesEndpoint, kind, signal);
      signal.throwIfAborted();
      if (target.candidates.filter((candidate) => candidate.kind === kind).some((candidate) =>
        !directory.data.some((entry) => entry.kind === kind && entry.id === candidate.id && entry.version === candidate.version)))
        throw new ApiError('protocol', 'import_debug_target_changed', '导入后插件已更新或移除，请核对当前版本再调试；无需重复导入', null, directory.logId);
    }
  }
  if (!services.context.services) throw new Error('调试器调用能力已撤销');
  await services.context.services.call({ id: 'host.debugger', version: '1' }, {
    action: 'focus', input: { candidates: target.candidates.map((candidate) => ({
      target_kind: candidate.kind, plugin_id: candidate.id,
    })), installation_id: target.installation?.id ?? null },
  }, signal);
}
