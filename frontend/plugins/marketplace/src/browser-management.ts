import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, HostResult, JsonValue } from '@deviceforge/plugin-sdk';

export const BROWSER_MANAGEMENT_SERVICE = { id: 'host.browser-plugins', version: '1' };
export const BROWSER_MANAGEMENT_CHANGED = 'host.browser-plugins.changed';
export type InstallationSource =
  | { kind: 'offline'; artifactId: string }
  | { kind: 'market'; sourceUrl: string; releaseId: string; version: string; releaseDigest: string };
export type BrowserManagementRequest =
  | { action: 'snapshot' | 'refresh' }
  | { action: 'setEnabled'; source: 'package' | 'bundled'; id: string; enabled: boolean }
  | { action: 'package'; operation: 'upload' | 'update'; id: string; artifactId: string;
      mediaType: 'application/zip' | 'application/gzip'; version: string }
  | { action: 'package'; operation: 'remove'; id: string }
  | { action: 'configuration'; operation: 'get'; id: string }
  | { action: 'configuration'; operation: 'save'; id: string; revision: string; values: JsonValue }
  | { action: 'configuration'; operation: 'reset' | 'apply'; id: string; revision: string }
  | { action: 'installation'; operation: 'install'; source: InstallationSource }
  | { action: 'installation'; operation: 'update'; id: string; revision: string; source: InstallationSource }
  | { action: 'installation'; operation: 'enable' | 'disable' | 'remove' | 'retryBrowser'; id: string; revision: string };

export interface BrowserCatalog {
  readonly snapshotVersion: 1;
  readonly packages: JsonValue;
  readonly installations: JsonValue;
  readonly runtime: readonly JsonValue[];
  readonly bundled: readonly JsonValue[];
  readonly clients: readonly JsonValue[];
  readonly progress: JsonValue;
  readonly cleanup: readonly JsonValue[];
  readonly workspaceCleanup: readonly JsonValue[];
}
function object(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function browserCatalog(value: JsonValue): BrowserCatalog {
  if (!object(value) || value.snapshotVersion !== 1 ||
      value.packages === undefined || !object(value.packages) ||
      value.installations === undefined || !object(value.installations) ||
      !Array.isArray(value.runtime) || !Array.isArray(value.bundled) ||
      !Array.isArray(value.clients) || !Array.isArray(value.cleanup) ||
      !Array.isArray(value.workspaceCleanup) || value.progress === undefined)
    throw new HostError('protocol', 'invalid_browser_catalog', '浏览器管理目录格式不兼容');
  for (const directory of [value.packages, value.installations]) {
    if (!object(directory) || typeof directory.known !== 'boolean' ||
        typeof directory.pending !== 'boolean' || !Array.isArray(directory.entries) ||
        directory.error === undefined || !(directory.logId === null || typeof directory.logId === 'string'))
      throw new HostError('protocol', 'invalid_browser_catalog', '浏览器安装目录状态不兼容');
  }
  return {
    snapshotVersion: 1, packages: value.packages, installations: value.installations,
    runtime: value.runtime, bundled: value.bundled, clients: value.clients, progress: value.progress,
    cleanup: value.cleanup, workspaceCleanup: value.workspaceCleanup,
  };
}
/** 管理调用始终返回真实回执；失败或结果未知时不自动重放写入。 */
export function createBrowserManagementClient(context: HostContext) {
  const request = async (input: BrowserManagementRequest, signal: AbortSignal): Promise<HostResult<JsonValue>> => {
    if (!context.services)
      return Promise.reject(new HostError('protocol', 'browser_management_unavailable', '宿主尚未提供浏览器管理服务'));
    return context.services.call(BROWSER_MANAGEMENT_SERVICE, input, signal);
  };
  return {
    request,
    async snapshot(signal: AbortSignal) {
      const result = await request({ action: 'snapshot' }, signal);
      return { data: browserCatalog(result.data), logId: result.logId };
    },
    async refresh(signal: AbortSignal) {
      const result = await request({ action: 'refresh' }, signal);
      return { data: browserCatalog(result.data), logId: result.logId };
    },
    subscribe(listener: () => void) {
      if (!context.extensions) throw new HostError('protocol', 'browser_management_unavailable', '宿主未提供管理事件');
      return context.extensions.subscribeEvent(BROWSER_MANAGEMENT_CHANGED, listener);
    },
  };
}
