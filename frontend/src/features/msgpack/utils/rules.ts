import { ApiError } from '../../../services/api/index.ts';
import { isJsonData, jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { JsonData } from '../../../shared/jobs/index.ts';
import type {
  MsgpackByIdInput,
  MsgpackConversionInput,
  MsgpackFilter,
  MsgpackPageInput,
} from '../types/index.ts';

export type NormalizedMsgpackPage = {
  readonly artifact_id: string;
  readonly offset: number;
  readonly limit: number;
  readonly filter?: MsgpackFilter;
};
export const maximumArtifactSize = 16 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidInput(): ApiError {
  return new ApiError(
    'protocol',
    'invalid_msgpack_input',
    'MessagePack 输入与公开产物、分页或筛选契约不兼容',
  );
}
export function isMsgpackJson(value: unknown): value is JsonData {
  if (!isJsonData(value)) return false;
  function safe(item: JsonData): boolean {
    if (typeof item === 'number') return !Number.isInteger(item) || Number.isSafeInteger(item);
    if (item === null || typeof item !== 'object') return true;
    return Object.values(item).every(safe);
  }
  return safe(value);
}
function normalizeArtifactId(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalidInput();
  return value.toLowerCase();
}
export function normalizeConversion(input: MsgpackConversionInput): MsgpackConversionInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id'])) throw invalidInput();
  return { artifact_id: normalizeArtifactId(input.artifact_id) };
}
function normalizeFilter(value: unknown): MsgpackFilter {
  if (
    !jsonObject(value) ||
    !onlyKeys(value, ['field', 'operator', 'value']) ||
    !Object.hasOwn(value, 'value') ||
    typeof value.field !== 'string' ||
    new TextEncoder().encode(value.field).length < 1 ||
    new TextEncoder().encode(value.field).length > 100 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value.field) ||
    !isMsgpackJson(value.value)
  )
    throw invalidInput();
  const field = value.field;
  const copied = structuredClone(value.value);
  if (value.operator === 'equals') return { field, operator: 'equals', value: copied };
  if (value.operator === 'contains' && typeof copied === 'string')
    return { field, operator: 'contains', value: copied };
  if ((value.operator === 'greater' || value.operator === 'less') && typeof copied === 'number') {
    return { field, operator: value.operator, value: copied };
  }
  throw invalidInput();
}
export function normalizePage(input: MsgpackPageInput): NormalizedMsgpackPage {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'offset', 'limit', 'filter']))
    throw invalidInput();
  const artifact_id = normalizeArtifactId(input.artifact_id);
  const offset = Object.hasOwn(input, 'offset') ? input.offset : 0;
  const limit = Object.hasOwn(input, 'limit') ? input.limit : 50;
  if (
    !naturalNumber(offset) ||
    offset > 100000 ||
    !naturalNumber(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw invalidInput();
  return Object.hasOwn(input, 'filter')
    ? { artifact_id, offset, limit, filter: normalizeFilter(input.filter) }
    : { artifact_id, offset, limit };
}
export function normalizeById(input: MsgpackByIdInput): NormalizedMsgpackPage {
  if (
    !jsonObject(input) ||
    !onlyKeys(input, ['artifact_id', 'id']) ||
    !Object.hasOwn(input, 'id') ||
    !isMsgpackJson(input.id)
  )
    throw invalidInput();
  return {
    artifact_id: normalizeArtifactId(input.artifact_id),
    offset: 0,
    limit: 1,
    filter: { field: 'id', operator: 'equals', value: structuredClone(input.id) },
  };
}
