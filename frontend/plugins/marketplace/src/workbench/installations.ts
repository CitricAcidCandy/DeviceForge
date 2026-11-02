import type { Job } from '@deviceforge/plugin-sdk';
import type { JobEventDto, InstalledReleaseDto } from './api/index.ts';
import type { MarketplaceEntry } from '../model/index.ts';
export type { InstallationSource } from '../browser-management.ts';
export interface InstallationComponent {
  readonly id: string; readonly kind: 'server' | 'browser'; readonly version: string;
  readonly entryPath: string; readonly revision: string; readonly entryUrl: string | null;
}
export interface PluginInstallation {
  readonly id: string; readonly version: string; readonly revision: string; readonly enabled: boolean;
  readonly status: InstalledReleaseDto['status']; readonly failure?: InstalledReleaseDto['failure'];
  readonly name: string; readonly summary: string; readonly description: string;
  readonly components: readonly InstallationComponent[];
}
export interface InstallationClientState {
  readonly id: string; readonly revision: string; readonly phase: 'activating' | 'enabled' | 'disabled' | 'failed';
  readonly message: string | null; readonly logId: string | null;
}
export interface InstallationProgress {
  readonly jobId: string; readonly operation: string; readonly status: Job['status'];
  readonly progress: NonNullable<JobEventDto['progress']> | null; readonly logId: string | null;
}
const retryable = new Set(['component_cleanup', 'activation_cleanup', 'enable_cleanup', 'activation_reload',
  'startup_activation', 'unload_rollback', 'configuration_rollback', 'disable_rollback']);
export function isLegacyCleanupWarning(value: PluginInstallation | null | undefined) {
  return value?.failure != null && retryable.has(value.failure.phase);
}
export function installationRequiresRecovery(value: PluginInstallation | null | undefined) {
  return value?.status === 'recovery_blocked' && !isLegacyCleanupWarning(value);
}
export function isReleaseEntry(entry: MarketplaceEntry): boolean {
  const version = entry.details['release_format_version'];
  return entry.kind === 'plugin' && (version === 1 || version === 2 || entry.details['release_format'] === 1);
}
export function marketInstallationSource(entry: MarketplaceEntry) {
  if (!isReleaseEntry(entry) || entry.metadataIssues?.length || !entry.id.trim() || !entry.version.trim() ||
      !entry.resource_id || !/^[a-f0-9]{64}$/u.test(entry.resource_id)) throw new Error('发布清单身份、元数据或摘要无效');
  const base = new URL(entry.source);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error('市场来源必须是不含凭证、查询参数或片段的 HTTP 地址');
  return { kind: 'market' as const, sourceUrl: `${base.toString().replace(/\/$/u, '')}/api/v1/resources/${entry.resource_id}`,
    releaseId: entry.id, version: entry.version, releaseDigest: entry.resource_id };
}
export function ownedInstallationComponents(values: readonly PluginInstallation[]): ReadonlySet<string> {
  return new Set(values.flatMap((value) => value.components.map((component) => `${component.kind}:${component.id}`)));
}
