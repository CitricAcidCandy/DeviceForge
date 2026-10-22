import { isSchemaValue } from '../../../utils/schema.ts';
import type { BrowserConfigurationRecord } from '../types/browser.ts';

export function readLegacyBrowserConfiguration(
  baseUrl: string,
  id: string,
  storage?: Storage,
): BrowserConfigurationRecord | null {
  const namespace = new URL(baseUrl).toString().replace(/\/$/, '');
  const text = storage?.getItem(
    `deviceforge.plugin-configuration:${encodeURIComponent(namespace)}:${encodeURIComponent(id)}`,
  );
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('浏览器插件旧配置记录损坏，未迁移到服务器');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    !('values' in value) ||
    !('revision' in value) ||
    !('applied' in value) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !isSchemaValue(value.values) ||
    value.values === null ||
    typeof value.values !== 'object' ||
    Array.isArray(value.values) ||
    typeof value.revision !== 'string' ||
    !value.revision.trim() ||
    typeof value.applied !== 'string' ||
    ('sensitivePaths' in value &&
      (!Array.isArray(value.sensitivePaths) ||
        !value.sensitivePaths.every(
          (path: unknown) => typeof path === 'string' && (path === '' || path.startsWith('/')),
        )))
  )
    throw new Error('浏览器插件旧配置记录损坏，未迁移到服务器');
  return {
    version: value.version,
    values: value.values,
    revision: value.revision,
    applied: value.applied,
    sensitivePaths:
      'sensitivePaths' in value && Array.isArray(value.sensitivePaths)
        ? value.sensitivePaths.filter((path): path is string => typeof path === 'string')
        : [],
  };
}
