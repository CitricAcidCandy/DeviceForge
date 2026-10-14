import { ApiError } from '../../../services/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { SpreadsheetArtifactInput, SpreadsheetReadInput } from '../types/index.ts';

export const byteLength = (value: string): number => new TextEncoder().encode(value).length;
export function validUnicode(value: string): boolean {
  return [...value].every((character) => { const point = character.codePointAt(0) ?? -1; return point < 0xd800 || point > 0xdfff; });
}
export const boundedText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && validUnicode(value) && byteLength(value) <= maximum;
const invalid = () => new ApiError('protocol', 'invalid_spreadsheet_input', '表格输入须为产物ID、精确工作表及有界分页');
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
export function frozenCopy<T>(value: T): T { const copied = structuredClone(value); freeze(copied); return copied; }
function artifactId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid();
  return value.toLowerCase();
}
export function normalizeInspect(input: SpreadsheetArtifactInput): SpreadsheetArtifactInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id'])) throw invalid();
  return frozenCopy({ artifact_id: artifactId(input.artifact_id) });
}
export function normalizeRead(input: SpreadsheetReadInput): SpreadsheetReadInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'sheet', 'offset', 'limit'])
    || Object.hasOwn(input, 'sheet') && !(boundedText(input.sheet, 512) || naturalNumber(input.sheet))
    || Object.hasOwn(input, 'offset') && !(naturalNumber(input.offset) && input.offset <= 10000)
    || Object.hasOwn(input, 'limit') && !(naturalNumber(input.limit) && input.limit >= 1 && input.limit <= 500)) throw invalid();
  return frozenCopy({ artifact_id: artifactId(input.artifact_id),
    ...(input.sheet === undefined ? {} : { sheet: input.sheet }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }) });
}
export const isDefinitionSchema = (value: unknown): boolean => jsonObject(value) && value.type === 'object';
