import { ApiError } from '@deviceforge/plugin-sdk';
import type { HostContext, JsonValue } from '@deviceforge/plugin-sdk';
import { createBrowserManagementClient } from '../browser-management.ts';
import {
  deletePackageEndpoint, installPackageEndpoint, updatePackageEndpoint,
} from './api/index.ts';
import { isPackageInfo } from './api/validation.ts';
import type { ApiClient, PackageInfo, PackageKind, PackageMediaType } from './api/index.ts';

export function managementResult(value: JsonValue, logId: string | null): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.completed !== true ||
      value.result === undefined)
    throw new ApiError('protocol', 'invalid_marketplace_management_result', '管理调用没有返回可确认的最终回执', null, logId);
  return value.result;
}
/** 浏览器包必须经原控制器撤销本地来源；服务器包使用现有公开 HTTP。 */
export function createMarketplacePackages(context: HostContext, client: ApiClient) {
  const browser = createBrowserManagementClient(context);
  const identity = (value: unknown, kind: PackageKind, id: string | undefined, version: string | undefined, logId: string | null) => {
    if (!isPackageInfo(value) || value.kind !== kind || id !== undefined && value.id !== id ||
        version !== undefined && value.version !== version)
      throw new ApiError('protocol', 'marketplace_package_identity_mismatch', '插件包回执与预览身份不一致，请查询当前安装目录', null, logId);
    return value;
  };
  async function artifact(id: string, content: Blob, mediaType: PackageMediaType, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!context.artifacts) throw new ApiError('protocol', 'marketplace_artifacts_unavailable', '宿主未提供产物上传');
    const result = await context.artifacts.upload(`${id}.${mediaType === 'application/zip' ? 'zip' : 'tgz'}`, content, signal);
    signal.throwIfAborted();
    if (result.data.size !== content.size)
      throw new ApiError('protocol', 'marketplace_artifact_mismatch', '服务器产物大小与本地归档不一致', null, result.logId);
    return result.data.id;
  }
  return {
    async upload(kind: PackageKind, content: Blob, mediaType: PackageMediaType, caller: AbortSignal,
      expected?: Readonly<Pick<PackageInfo, 'id' | 'version'>>) {
      const signal = AbortSignal.any([caller, context.signal]);
      signal.throwIfAborted();
      if (kind === 'server') {
        const result = await client.call(installPackageEndpoint, { kind, content, mediaType, ...(expected ? { expected } : {}) }, signal);
        return { ...result, data: identity(result.data, kind, expected?.id, expected?.version, result.logId) };
      }
      if (!expected) throw new ApiError('protocol', 'marketplace_package_preview_required', '浏览器包上传需要预览确认的身份和版本');
      const artifactId = await artifact(expected.id, content, mediaType, signal);
      const result = await browser.request({ action: 'package', operation: 'upload', ...expected, artifactId, mediaType }, signal);
      return { data: identity(managementResult(result.data, result.logId), kind, expected.id, expected.version, result.logId), logId: result.logId };
    },
    async update(kind: PackageKind, id: string, content: Blob, mediaType: PackageMediaType, caller: AbortSignal, expectedVersion?: string) {
      const signal = AbortSignal.any([caller, context.signal]);
      signal.throwIfAborted();
      if (kind === 'server') {
        const result = await client.call(updatePackageEndpoint, {
          kind, id, content, mediaType, ...(expectedVersion === undefined ? {} : { expectedVersion }),
        }, signal);
        return { ...result, data: identity(result.data, kind, id, expectedVersion, result.logId) };
      }
      if (!expectedVersion) throw new ApiError('protocol', 'marketplace_package_preview_required', '浏览器包更新需要预览确认的版本');
      const artifactId = await artifact(id, content, mediaType, signal);
      const result = await browser.request({
        action: 'package', operation: 'update', id, artifactId, mediaType, version: expectedVersion,
      }, signal);
      return { data: identity(managementResult(result.data, result.logId), kind, id, expectedVersion, result.logId), logId: result.logId };
    },
    async remove(kind: PackageKind, id: string, caller: AbortSignal) {
      const signal = AbortSignal.any([caller, context.signal]);
      signal.throwIfAborted();
      const result = kind === 'server' ? await client.call(deletePackageEndpoint, { kind, id }, signal) :
        await browser.request({ action: 'package', operation: 'remove', id }, signal);
      const value = kind === 'server' ? result.data : managementResult(result.data, result.logId);
      return { data: identity(value, kind, id, undefined, result.logId), logId: result.logId };
    },
  };
}
