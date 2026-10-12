import { ApiError } from '../../shared/api/index.ts';

export function runtimeFeatureKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^(?:[\u0000-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/.test(value)
    && new TextEncoder().encode(value).byteLength <= 128;
}
export function requireRuntimeFeatureKey(value: unknown): void {
  if (!runtimeFeatureKey(value)) throw new ApiError('protocol', 'invalid_runtime_feature', '运行时功能标识须为 1–128 字节的有效 UTF-8 字符串');
}
