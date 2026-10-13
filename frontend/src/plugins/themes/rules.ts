import type { ThemeContribution } from '../../plugin-sdk/index.ts';

const encoder = new TextEncoder();
function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function variables(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([name, content]) => name.length <= 128
    && /^--[\p{L}\p{N}_-]+$/u.test(name) && typeof content === 'string'
    && content.trim().length > 0 && content.length <= 4096);
}
export function isThemeContribution(value: unknown): value is ThemeContribution {
  return record(value) && typeof value.id === 'string' && typeof value.title === 'string'
    && value.title.trim().length > 0 && variables(value.variables)
    && (value.css === undefined || typeof value.css === 'string' && encoder.encode(value.css).byteLength <= 256 * 1024)
    && (value.colorScheme === undefined || value.colorScheme === 'light' || value.colorScheme === 'dark' || value.colorScheme === 'normal');
}
export function copyThemeContribution(value: ThemeContribution): ThemeContribution {
  if (!isThemeContribution(value)) throw new Error('主题声明或稳定性限额无效');
  return Object.freeze<ThemeContribution>({
    id: value.id, title: value.title,
    ...(value.variables ? { variables: Object.freeze({ ...value.variables }) } : {}),
    ...(value.css !== undefined ? { css: value.css } : {}),
    ...(value.colorScheme !== undefined ? { colorScheme: value.colorScheme } : {}),
  });
}
