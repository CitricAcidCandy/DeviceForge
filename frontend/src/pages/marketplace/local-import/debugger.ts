import type { ProductServices } from '../../../app/product/services.ts';
import { ApiError, packagesEndpoint } from '../../../services/api/index.ts';
import { createInstallationGateway } from '../../../features/plugin-installations/index.ts';
import type { ImportedPluginDebugTarget } from './types.ts';

export function localImportDebugUnavailableReason(services: ProductServices): string | null {
  if (!services.runtime.debugger)
    return '调试仅支持本机连接，请使用 localhost 或 127.0.0.1 打开并连接 DeviceForge。';
  if (!services.runtime.extensions.catalog().components.some(component =>
    component.pluginId === 'deviceforge_debugger' && component.slot === 'developer.tools'))
    return '调试器尚未启用，请先在资源市场的已安装列表启用 DeviceForge 调试器。';
  return null;
}

/** 只打开工具并带入本次导入的候选，不启用被测插件、不打开会话或执行业务。 */
export async function openImportedPluginDebugger(services: ProductServices, target: ImportedPluginDebugTarget, signal: AbortSignal) {
  signal = AbortSignal.any([signal, services.runtime.host.signal]);
  signal.throwIfAborted();
  const unavailable = localImportDebugUnavailableReason(services);
  if (unavailable) throw new Error(unavailable);
  if (!target.candidates.length) throw new Error('本次导入没有可调试的插件组件，请查看实际安装目录。');
  if (target.installation) {
    const expected = target.installation;
    // 与导入完成后市场自动刷新的取消域分离，只读取原公开目录，不改写其页面状态。
    const directory = await createInstallationGateway(services.client).list(signal);
    signal.throwIfAborted();
    const installed = directory.data.find(item => item.id === expected.id);
    if (!installed || installed.revision !== expected.revision || target.candidates.some(candidate =>
      !installed.components.some(component => component.id === candidate.id && component.kind === candidate.kind && component.version === candidate.version)))
      throw new ApiError('protocol', 'import_debug_target_changed',
        '插件在导入后已被更新或移除，请到已安装列表核对当前版本后调试；无需重复导入。', null, directory.logId);
  } else {
    for (const kind of new Set(target.candidates.map(candidate => candidate.kind))) {
      const directory = await services.client.call(packagesEndpoint, kind, signal);
      signal.throwIfAborted();
      if (target.candidates.filter(candidate => candidate.kind === kind).some(candidate =>
        !directory.data.some(pkg => pkg.id === candidate.id && pkg.kind === kind && pkg.version === candidate.version)))
        throw new ApiError('protocol', 'import_debug_target_changed',
          '插件在导入后已被更新或移除，请到已安装列表核对当前版本后调试；无需重复导入。', null, directory.logId);
    }
  }
  signal.throwIfAborted();
  await services.runtime.extensions.callService('host.debugger', '1', { action: 'focus', input: {
    candidates: target.candidates.map(candidate => ({ target_kind: candidate.kind, plugin_id: candidate.id })),
    installation_id: target.installation?.id ?? null,
  } }, signal);
}
