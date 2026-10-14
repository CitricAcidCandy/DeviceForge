import { ApiError } from '../../../services/api/index.ts';
import { decimalU64 } from '../../../shared/jobs/index.ts';

export const toolModuleId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z][a-z0-9_-]{0,63}$/.test(value) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value);
export const toolVersion = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 128 &&
  value.split('.').length <= 8 &&
  value.split('.').every((part) => /^[0-9]+$/.test(part) && decimalU64(BigInt(part).toString()));
// 比较已经校验的版本，缺失段补零；不经浮点转换丢失 u64 精度。
export function compareToolVersions(left: string, right: string): -1 | 0 | 1 {
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = BigInt(a[index] ?? '0');
    const y = BigInt(b[index] ?? '0');
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
export function requireModuleId(value: string): void {
  if (!toolModuleId(value))
    throw new ApiError(
      'protocol',
      'invalid_tool_module',
      '工具模块 ID 须为小写字母开头的 1–64 位业务身份',
    );
}
export function requireSelection(values: readonly string[]): void {
  if (values.length > 128 || !values.every(toolModuleId) || new Set(values).size !== values.length)
    throw new ApiError(
      'protocol',
      'invalid_tool_selection',
      '工具选择不得重复且最多 128 个有效模块',
    );
}
