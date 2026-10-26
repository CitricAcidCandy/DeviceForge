import type { PluginInstallation } from '../types/index.ts';

const retryablePhases = new Set([
  'component_cleanup', 'activation_cleanup', 'enable_cleanup', 'activation_reload',
  'startup_activation', 'unload_rollback', 'configuration_rollback', 'disable_rollback',
]);

// 纯组件操作记录只作历史告警；文件事务故障与未知恢复原因仍阻断变更。
export function isLegacyCleanupWarning(value: PluginInstallation | null | undefined): boolean {
  return value?.failure != null && retryablePhases.has(value.failure.phase);
}

export function installationRequiresRecovery(value: PluginInstallation | null | undefined): boolean {
  return value?.status === 'recovery_blocked' && !isLegacyCleanupWarning(value);
}

export function installationCanRun(value: PluginInstallation): boolean {
  return value.enabled && (value.status === 'enabled' ||
    (value.status === 'recovery_blocked' && !installationRequiresRecovery(value)));
}
