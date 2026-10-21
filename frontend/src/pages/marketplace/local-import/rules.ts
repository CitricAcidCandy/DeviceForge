import { sha256 } from '@noble/hashes/sha2.js';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import type { LocalConfiguration, LocalToolManifest } from './types.ts';
import type { JsonData } from '../../../shared/jobs/index.ts';

const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const moduleIdentity = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z][a-z0-9_-]{0,63}$/.test(value) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value);

export async function readImportJson(file: File, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (file.size > 1024 * 1024 || file.size === 0)
    throw new Error('JSON 文件须为 1 MiB 以内的非空文件');
  const text = await file.text();
  signal.throwIfAborted();
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value;
  } catch {
    throw new Error('文件不是有效的 UTF-8 JSON');
  }
}

export function parseLocalConfiguration(value: unknown): LocalConfiguration {
  if (!jsonObject(value) || value.format_version !== 1)
    throw new Error('配置需要 format_version: 1 的 DeviceForge 导入封装');
  if (
    value.kind === 'settings' &&
    onlyKeys(value, ['format_version', 'kind', 'scope', 'owner_id', 'sections']) &&
    (value.scope === 'user' || value.scope === 'workspace') &&
    identity(value.owner_id) &&
    jsonObject(value.sections) &&
    Object.keys(value.sections).length > 0 &&
    Object.keys(value.sections).length <= 64 &&
    Object.keys(value.sections).every(identity)
  )
    return {
      kind: 'settings',
      scope: value.scope,
      owner_id: value.owner_id,
      sections: value.sections,
    };
  if (
    value.kind === 'server_plugin_configuration' &&
    onlyKeys(value, ['format_version', 'kind', 'plugin_id', 'values']) &&
    typeof value.plugin_id === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value.plugin_id) &&
    jsonObject(value.values)
  )
    return {
      kind: 'server_plugin_configuration',
      plugin_id: value.plugin_id,
      values: value.values,
    };
  throw new Error('配置封装的类型、目标或内容不符合 DeviceForge 规范');
}

// 与服务器 JSON 合并补丁一致：对象递归合并，null 删除，数组整体替换。
export function mergeConfigurationPreview(previous: JsonData, patch: JsonData): JsonData {
  if (!jsonObject(patch)) return patch;
  const fields = new Map(Object.entries(jsonObject(previous) ? previous : {}));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) fields.delete(key);
    else fields.set(key, mergeConfigurationPreview(fields.get(key) ?? null, value));
  }
  return Object.fromEntries(fields);
}

// 清单保留既有名称与别名；完整合法性由工具供应插件再次校验。
export function parseLocalToolManifest(value: unknown): LocalToolManifest {
  if (
    !jsonObject(value) ||
    !Array.isArray(value.modules) ||
    !value.modules.length ||
    value.modules.length > 128 ||
    typeof (value.manifestVersion ?? value.manifest_version) !== 'string'
  )
    throw new Error('请选择包含版本与 1–128 个模块的 DeviceForge 工具清单');
  const modules = value.modules.map((item) => {
    if (!jsonObject(item)) throw new Error('工具模块必须是对象');
    const id = item.name ?? item.module_id;
    if (
      !moduleIdentity(id) ||
      typeof item.version !== 'string' ||
      !/^\d+(?:\.\d+){0,7}$/.test(item.version) ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(item.sha256) ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0 ||
      typeof (item.url ?? item.download_url) !== 'string'
    )
      throw new Error('工具模块的身份、版本、来源 URL、大小或 SHA-256 无效');
    return { id, version: item.version, size: item.size, sha256: item.sha256.toLowerCase() };
  });
  if (new Set(modules.map((item) => item.id)).size !== modules.length)
    throw new Error('工具清单包含重复模块');
  return { value, modules };
}

export async function digestLocalFile(file: File, signal: AbortSignal): Promise<string> {
  const hash = sha256.create();
  const reader = file.stream().getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      hash.update(part.value);
    }
    return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
