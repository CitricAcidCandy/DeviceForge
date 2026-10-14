import { ApiError } from '../../../shared/api/index.ts';
import { jsonObject, onlyKeys, requireJson } from '../../../shared/jobs/index.ts';
import type { JsonData } from '../../../shared/jobs/index.ts';
import type { SettingsOwner } from '../types/index.ts';

export interface LegacySettingsFile { readonly name: string; readonly text: string }
export interface SettingsLegacyImport extends SettingsOwner {
  readonly expected_revision: string;
  readonly files: readonly LegacySettingsFile[];
}

// 固定沿用旧备份名称；保留旧配置区拼写，不根据服务器路径猜测名称。
const sectionsByFile = new Map<string, string>([
  ['deviceInfo.json', 'deviceInfo'],
  ['packageInfo.json', 'packageInfo'],
  ['iframePageUrl.json', 'iframePageUrl'],
  ['permissions.json', 'permissions'],
  ['luaCommand.json', 'luaCommand'],
  ['dynamicSnalysisHooks.json', 'dynamicSnalysisHooks'],
  ['packageSdk.json', 'packageSDK'],
]);

/** 仅供显式旧文本入口使用；JSON 字符串保持字符串，不递归解析正文。 */
export function parseLegacyEditorText(text: string): JsonData {
  try {
    if (typeof text !== 'string') throw invalidLegacy('旧配置内容必须为 JSON 文本');
    const value: unknown = JSON.parse(text);
    return requireJson(value);
  } catch {
    throw invalidLegacy('旧配置内容不是有效的有限 JSON 数据');
  }
}

/** 整批转换成功后才能提交；不读取文件系统、不选择归属、不访问远端。 */
export function convertLegacyFiles(files: readonly LegacySettingsFile[]): { [key: string]: JsonData } {
  if (!Array.isArray(files) || files.length < 1 || files.length > sectionsByFile.size) {
    throw invalidLegacy('旧配置导入须选择一至七个已知备份文件');
  }
  const sections: { [key: string]: JsonData } = {};
  for (const file of files) {
    if (!jsonObject(file) || !onlyKeys(file, ['name', 'text']) || typeof file.name !== 'string' || typeof file.text !== 'string') {
      throw invalidLegacy('旧配置文件须提供名称和 JSON 文本');
    }
    const section = sectionsByFile.get(file.name);
    if (section === undefined || Object.hasOwn(sections, section)) {
      throw invalidLegacy('旧配置文件名未知或重复');
    }
    try { sections[section] = parseLegacyEditorText(file.text); }
    catch { throw invalidLegacy(`旧配置文件 JSON 无效：${file.name}`); }
  }
  return sections;
}

function invalidLegacy(message: string): ApiError {
  return new ApiError('protocol', 'invalid_legacy_settings', message);
}
