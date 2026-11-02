import { isRecord } from '@deviceforge/business-kit/api';
import { naturalNumber } from '@deviceforge/business-kit/jobs';

/** 会话 HTTP 元数据使用服务器蛇形契约，不混用工作区操作目录的驼峰适配。 */
export function isOperationExecution(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
      !Object.keys(value).every((key) => ['api_version', 'source', 'total_timeout_ms'].includes(key)))
    return false;
  return value.api_version === 1 && naturalNumber(value.total_timeout_ms) &&
    value.total_timeout_ms > 0 && value.total_timeout_ms <= 3600000 &&
    (value.source === 'default' || value.source === 'declared');
}

export function isArtifactMetadata(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) &&
    typeof value.filename === 'string' && value.filename.length > 0 &&
    typeof value.media_type === 'string' && value.media_type.length > 0 &&
    naturalNumber(value.size) && naturalNumber(value.created_at) &&
    typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(value.sha256);
}
