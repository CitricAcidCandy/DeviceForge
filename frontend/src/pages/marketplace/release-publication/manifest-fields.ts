const encoder = new TextEncoder();
export const byteLength = (value: string) => encoder.encode(value).byteLength;

export function fields(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.keys(value).every((key) => allowed.includes(key)))
    throw new Error(`${label}含未知字段或不是对象`);
  return Object.fromEntries(Object.entries(value));
}

export function text(value: unknown, maxBytes: number, label: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || byteLength(value) > maxBytes)
    throw new Error(`${label}为空或超过字节限制`);
  return value;
}

export function identifier(value: unknown): string {
  const result = text(value, 128, '发布标识');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result) || result.startsWith('builtin.'))
    throw new Error('发布标识包含无效字符或保留前缀');
  return result;
}

export function version(value: unknown): string {
  const result = text(value, 100, '发布版本');
  if (!/^[A-Za-z0-9._+-]+$/.test(result) || ['.', '..', 'unresolved'].includes(result) ||
      /^v?\d+(?:\.\d+)?$/.test(result) || /^(?:\d+\.)*[xX]$/.test(result))
    throw new Error('发布版本必须为已锁定版本，不能为开发版本范围');
  return result;
}

export function relative(value: unknown): string {
  const result = text(value, 512, '发布资源路径');
  if (/[\\:\u0000?#%]/.test(result) || result.startsWith('/') ||
      result.split('/').some((part) => !part || ['.', '..'].includes(part) ||
        /[. ]$/.test(part) || /[\u0000-\u001f\u007f<>"|?*]/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))
    throw new Error('发布路径含越界或系统保留片段');
  return result;
}

export function pointer(value: unknown): string {
  const result = text(value, 512, '配置指针');
  if (!result.startsWith('/') || /[\u0000-\u001f\u007f]/.test(result) || /~(?![01])/u.test(result))
    throw new Error('配置绑定须为有效 JSON Pointer');
  return result;
}

export function list(value: unknown, max: number, label: string, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`${label}数量无效`);
  return value;
}

export function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('发布布尔字段无效');
  return value;
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}重复`);
}
