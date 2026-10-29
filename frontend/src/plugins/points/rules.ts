import { HostError } from '../../plugin-sdk/models.ts';
import type { JsonValue } from '../../plugin-sdk/models.ts';
import type { PointContribution, PointDefinition, PointMode, PointRef } from '../../plugin-sdk/points.ts';

const identifier = /^[a-z][a-z0-9._-]{0,199}$/;
const modes: readonly PointMode[] = ['append', 'replace'];

export function checkPointRef(ref: PointRef): void {
  if (!identifier.test(ref.id) || typeof ref.version !== 'string' || !ref.version.trim() || ref.version.length > 100)
    throw new Error('扩展点标识或精确版本无效');
}
export function checkOwnedId(pluginId: string, id: string): void {
  if (!identifier.test(id) || !id.startsWith(`${pluginId}.`))
    throw new Error('扩展点或贡献标识超出插件命名空间');
}
export function pointKey(ref: PointRef): string {
  return JSON.stringify([ref.id, ref.version]);
}
export function samePoint(left: PointRef, right: PointRef): boolean {
  return left.id === right.id && left.version === right.version;
}
export function checkDefinition(pluginId: string, definition: PointDefinition): void {
  checkPointRef(definition);
  checkOwnedId(pluginId, definition.id);
  if (typeof definition.title !== 'string' || !definition.title.trim() || definition.title.length > 400)
    throw new Error('扩展点标题为空或过长');
  const allowed = definition.modes ?? modes;
  if (!Array.isArray(allowed) || !allowed.length || allowed.length > modes.length ||
      new Set(allowed).size !== allowed.length || allowed.some((mode) => !modes.includes(mode)))
    throw new Error('扩展点允许模式无效');
}
export function checkContribution(pluginId: string, contribution: PointContribution): void {
  checkOwnedId(pluginId, contribution.id);
  checkPointRef(contribution.point);
  if (contribution.order !== undefined && !Number.isSafeInteger(contribution.order))
    throw new Error('贡献顺序必须是安全整数');
  if (contribution.mode !== undefined && !modes.includes(contribution.mode))
    throw new Error('贡献模式无效');
}

/** 快照只接受有界 JSON，防止函数、循环对象和非有限数被序列化时静默改变。 */
export function snapshotJson(input: JsonValue): JsonValue {
  let remaining = 8192;
  const ancestors = new Set<object>();
  function check(value: unknown, depth: number): void {
    if (--remaining < 0 || depth > 32) throw new Error('扩展点数据结构过大');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || value === null) throw new Error('扩展点数据必须是 JSON');
    if (ancestors.has(value)) throw new Error('扩展点数据不能循环引用');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new Error('扩展点数据必须是普通 JSON 对象');
    ancestors.add(value);
    for (const nested of Array.isArray(value) ? value : Object.values(value)) check(nested, depth + 1);
    ancestors.delete(value);
  }
  check(input, 0);
  if (JSON.stringify(input).length > 65536) throw new Error('扩展点数据超过 64 KiB');
  return freezeJson(structuredClone(input));
}
function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeJson(nested);
    Object.freeze(value);
  }
  return value;
}
export function current(signal: AbortSignal): void {
  if (signal.aborted) throw new HostError('cancelled', 'point_scope_revoked', '扩展点作用域已撤销');
}
