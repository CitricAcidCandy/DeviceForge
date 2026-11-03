import { ApiError } from '@deviceforge/plugin-sdk';
import { isRecord } from '@deviceforge/business-kit/api';
import type { BrowserCatalog } from '../browser-management.ts';
import type { InstallationClientState, InstallationProgress, PluginInstallation } from './installations.ts';
import type { PackageInfo } from './api/index.ts';
import { isPackageInfo, isJobEvent } from './api/validation.ts';
import type { BrowserRuntime } from './browser-state.ts';

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
export function isInstallation(value: unknown): value is PluginInstallation {
  if (!isRecord(value) || !text(value.id) || !text(value.version) || !text(value.revision) ||
      !/^[a-f0-9]{64}$/u.test(value.revision) || typeof value.name !== 'string' || typeof value.summary !== 'string' ||
      typeof value.description !== 'string' || typeof value.enabled !== 'boolean' ||
      !['installed', 'enabled', 'configuration_required', 'dependencies_required', 'recovery_blocked'].includes(String(value.status)) ||
      !Array.isArray(value.components) || !value.components.every((entry: unknown) =>
        isRecord(entry) && text(entry.id) && (entry.kind === 'server' || entry.kind === 'browser') &&
        text(entry.version) && text(entry.revision) && text(entry.entryPath) && nullableText(entry.entryUrl))) return false;
  return value.failure === undefined || value.failure === null ||
    isRecord(value.failure) && text(value.failure.phase) && typeof value.failure.reason === 'string';
}
function isClient(value: unknown): value is InstallationClientState {
  return isRecord(value) && text(value.id) && text(value.revision) &&
    ['activating', 'enabled', 'disabled', 'failed'].includes(String(value.phase)) &&
    nullableText(value.message) && nullableText(value.logId);
}
function isRuntime(value: unknown): value is BrowserRuntime {
  return isRecord(value) && text(value.id) && typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) && value.generation > 0 &&
    (value.state === 'loading' || value.state === 'loaded');
}
export function isProgress(value: unknown): value is InstallationProgress {
  return isRecord(value) && text(value.jobId) && text(value.operation) && nullableText(value.logId) &&
    isJobEvent({ job_id: value.jobId, sequence: 0, timestamp: 0, status: value.status, progress: value.progress });
}
export interface BundledEntry {
  readonly id: string; readonly title: string; readonly version: string;
  readonly phase: 'idle' | 'loading' | 'loaded' | 'disabled' | 'external' | 'unavailable' | 'failed';
  readonly error: string | null; readonly source: string;
}
function isBundled(value: unknown): value is BundledEntry {
  return isRecord(value) && text(value.id) && text(value.title) && text(value.version) &&
    ['idle', 'loading', 'loaded', 'disabled', 'external', 'unavailable', 'failed'].includes(String(value.phase)) &&
    nullableText(value.error) && typeof value.source === 'string';
}
export function decodeBrowserCatalog(value: BrowserCatalog, logId: string | null) {
  const invalid = () => new ApiError('protocol', 'invalid_marketplace_management_result', '浏览器管理目录条目不兼容', null, logId);
  function array<T>(value: unknown, guard: (entry: unknown) => entry is T): readonly T[] {
    if (!Array.isArray(value)) throw invalid();
    const entries: readonly unknown[] = value;
    if (!entries.every(guard)) throw invalid();
    return entries;
  }
  const packages = value.packages, installations = value.installations;
  if (!isRecord(packages) || !Array.isArray(packages.entries) || !packages.entries.every(isPackageInfo) ||
      typeof packages.known !== 'boolean' || typeof packages.pending !== 'boolean' ||
      !isRecord(installations) || !Array.isArray(installations.entries) || !installations.entries.every(isInstallation) ||
      typeof installations.known !== 'boolean' || typeof installations.pending !== 'boolean' ||
      !value.clients.every(isClient) || !value.bundled.every(isBundled) ||
      value.progress !== null && !isProgress(value.progress)) throw invalid();
  const installedPackages: readonly PackageInfo[] = array(packages.entries, isPackageInfo);
  const installedReleases = array(installations.entries, isInstallation);
  const runtime = array(value.runtime, isRuntime);
  if (new Set(runtime.map((entry) => entry.id)).size !== runtime.length) throw invalid();
  return {
    packages: installedPackages, installations: installedReleases, clients: array(value.clients, isClient),
    runtime,
    progress: value.progress, bundled: array(value.bundled, isBundled),
    known: packages.known && installations.known, pending: packages.pending || installations.pending,
    error: packages.error ?? installations.error ?? null,
  };
}
export type BrowserCatalogState = ReturnType<typeof decodeBrowserCatalog>;
