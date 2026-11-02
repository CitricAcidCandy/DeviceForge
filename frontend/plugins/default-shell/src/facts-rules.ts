import type { JsonValue } from '@deviceforge/plugin-sdk';

export interface ShellObservation<T> {
  readonly value: T | null;
  readonly state: 'waiting' | 'loading' | 'confirmed' | 'stale' | 'failed';
  readonly error: string | null;
  readonly logId: string | null;
}
export interface ShellFacts {
  readonly endpoint: ShellObservation<string>;
  readonly plugins: ShellObservation<number>;
}
export function waiting<T>(): ShellObservation<T> {
  return { value: null, state: 'waiting', error: null, logId: null };
}
function object(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function serviceEndpoint(value: JsonValue): string {
  if (!object(value) || typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048)
    throw new Error('服务地址状态不兼容');
  let url: URL;
  try { url = new URL(value.baseUrl); } catch { throw new Error('服务地址状态无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('服务地址状态无效');
  return url.origin;
}
export function loadedPluginCount(value: JsonValue): number {
  if (!object(value) || value.snapshotVersion !== 1 || !Array.isArray(value.runtime) || value.runtime.length > 10_000)
    throw new Error('插件运行目录不兼容');
  const seen = new Set<string>();
  let count = 0;
  for (const entry of value.runtime) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.state !== 'string' || seen.has(entry.id))
      throw new Error('插件运行目录包含无效或重复身份');
    seen.add(entry.id);
    if (entry.state === 'loaded') count++;
  }
  return count;
}
