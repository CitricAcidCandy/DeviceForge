import type { paths } from './generated.ts';
import type { Endpoint } from './types.ts';
import { ApiError } from './errors.ts';
import { isRecord } from './validation.ts';

type Response = paths['/api/v2/diagnostics/logs']['get']['responses'][200]['content']['application/json'];
export type LogSearchDto = Response['data'];
export type LogEntryDto = LogSearchDto['entries'][number];
export type LogQuery = NonNullable<paths['/api/v2/diagnostics/logs']['get']['parameters']['query']>;
export type LogOrder = NonNullable<LogQuery['order']>;
export const isLogIdentifier = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
export const isLogSearchText = (value: string) => value.trim().length > 0 &&
  new TextEncoder().encode(value.trim()).length <= 128 && !/\p{Cc}/u.test(value.trim());

function nullableText(value: unknown): boolean { return value === null || typeof value === 'string'; }
function isEntry(value: unknown): value is LogEntryDto {
  return isRecord(value) && typeof value.timestamp === 'string' && typeof value.level === 'string' &&
    typeof value.message === 'string' && value.message.length <= 512 &&
    ['job_id', 'operation', 'code', 'method', 'route'].every((key) => nullableText(value[key])) &&
    (value.log_id == null || (typeof value.log_id === 'string' && isLogIdentifier(value.log_id))) &&
    (value.job_id === null || (typeof value.job_id === 'string' && isLogIdentifier(value.job_id))) &&
    (value.status === null || (typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 0 && value.status <= 65535));
}
function isSearch(value: unknown): value is LogSearchDto {
  return isRecord(value) && (value.log_id === null || (typeof value.log_id === 'string' && isLogIdentifier(value.log_id))) &&
    typeof value.limited === 'boolean' && Array.isArray(value.entries) && value.entries.length <= 100 && value.entries.every(isEntry) &&
    Array.isArray(value.job_ids) && value.job_ids.length <= 20 &&
    value.job_ids.every((id: unknown) => typeof id === 'string' && isLogIdentifier(id)) &&
    new Set(value.job_ids).size === value.job_ids.length;
}
export const logSearchEndpoint: Endpoint<string, LogSearchDto> = {
  request(id) {
    if (!isLogIdentifier(id)) throw new ApiError('protocol', 'invalid_input', '请填写完整的任务 ID 或日志 ID');
    return { method: 'GET', path: `/api/v2/diagnostics/logs?log_id=${encodeURIComponent(id)}` };
  },
  decode: isSearch,
};

export const logQueryEndpoint: Endpoint<LogQuery, LogSearchDto> = {
  request(input) {
    const byId = input.log_id != null;
    if (byId === (input.q != null) ||
      (byId && !isLogIdentifier(input.log_id ?? '')) ||
      (!byId && !isLogSearchText(input.q ?? '')) ||
      (input.order != null && input.order !== 'asc' && input.order !== 'desc'))
      throw new ApiError('protocol', 'invalid_input', '请填写完整日志 ID 或 1 至 128 字节的搜索词，并选择时间升序或倒序');
    const params = new URLSearchParams();
    if (input.log_id != null) params.set('log_id', input.log_id);
    if (input.q != null) params.set('q', input.q.trim());
    if (input.order != null) params.set('order', input.order);
    return { method: 'GET', path: `/api/v2/diagnostics/logs?${params}` };
  },
  decode: isSearch,
};
