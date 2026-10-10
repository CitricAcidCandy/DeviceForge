// 普通操作目录的执行元数据校验；不依赖生成 DTO，不填默认值或裁剪预算。
export function isOperationExecution(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => key === 'api_version' || key === 'total_timeout_ms' || key === 'source')) return false;
  return 'api_version' in value && value.api_version === 1
    && 'total_timeout_ms' in value && typeof value.total_timeout_ms === 'number'
    && Number.isSafeInteger(value.total_timeout_ms) && value.total_timeout_ms >= 1 && value.total_timeout_ms <= 3600000
    && 'source' in value && (value.source === 'default' || value.source === 'declared');
}
