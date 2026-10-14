import { ApiError } from '../../../shared/api/index.ts';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import { copySpreadsheetPage } from './results.ts';
import { boundedText, frozenCopy } from './rules.ts';
import type { SpreadsheetCell, SpreadsheetFieldMapping, SpreadsheetImportField, SpreadsheetImportOptions, SpreadsheetImportPage, SpreadsheetMissingValue, SpreadsheetPage, SpreadsheetRow } from './types.ts';

const invalid = () => new ApiError('protocol', 'invalid_spreadsheet_mapping', '字段定义、映射或表头不符合导入规则');
function requireFields(fields: readonly SpreadsheetImportField[]): void {
  if (!Array.isArray(fields) || fields.some((field) => !jsonObject(field) || !onlyKeys(field, ['key', 'label', 'required', 'description'])
    || !boundedText(field.key, 512) || !boundedText(field.label, 512)
    || Object.hasOwn(field, 'required') && typeof field.required !== 'boolean'
    || Object.hasOwn(field, 'description') && typeof field.description !== 'string')
    || new Set(fields.map((field) => field.key)).size !== fields.length) throw invalid();
}
function requireMapping(mapping: SpreadsheetFieldMapping): void {
  if (mapping === null || typeof mapping !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))
    || Object.getOwnPropertySymbols(mapping).length > 0
    || Object.values(Object.getOwnPropertyDescriptors(mapping)).some((descriptor) => !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined)
    || Object.values(mapping).some((value) => value !== undefined && typeof value !== 'string')) throw invalid();
}
function resolveHeader(headers: readonly string[], candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  if (headers.includes(candidate)) return candidate;
  const normalized = candidate.trim().toLowerCase();
  return headers.find((header) => header.trim().toLowerCase() === normalized);
}
// 逐候选解析，保留旧previous/default/key/label优先级与首匹配规则。
export function buildFieldMapping(fields: readonly SpreadsheetImportField[], headers: readonly string[], defaultMapping: SpreadsheetFieldMapping = {}, previousMapping: SpreadsheetFieldMapping = {}): SpreadsheetFieldMapping {
  requireFields(fields); requireMapping(defaultMapping); requireMapping(previousMapping);
  if (!Array.isArray(headers) || headers.length > 256 || !headers.every((header) => boundedText(header, 512)) || new Set(headers).size !== headers.length) throw invalid();
  return frozenCopy(Object.fromEntries(fields.map((field): [string, string | undefined] => {
    const candidates = [previousMapping[field.key], defaultMapping[field.key], field.key, field.label];
    const resolved = candidates.map((candidate) => resolveHeader(headers, candidate)).find((header) => header !== undefined);
    return [field.key, resolved];
  })));
}
export function requiredUnmappedFields(fields: readonly SpreadsheetImportField[], mapping: SpreadsheetFieldMapping): readonly SpreadsheetImportField[] {
  requireFields(fields); requireMapping(mapping);
  return frozenCopy(fields.filter((field) => field.required === true && mapping[field.key] === undefined));
}
export const isEmptyImportCell = (value: SpreadsheetCell | undefined): boolean => value === undefined || value === null || typeof value === 'string' && value.trim().length === 0;

export function prepareSpreadsheetImportPage(page: SpreadsheetPage, fields: readonly SpreadsheetImportField[], options: SpreadsheetImportOptions = {}): SpreadsheetImportPage {
  const current = copySpreadsheetPage(page); const copiedFields = frozenCopy(fields);
  const mapping = buildFieldMapping(copiedFields, current.headers, options.defaultMapping, options.previousMapping);
  const missingMappings = requiredUnmappedFields(copiedFields, mapping);
  let filtered: readonly SpreadsheetRow[] = current.rows;
  if (options.filterRows) {
    try { filtered = options.filterRows(current.rows); }
    catch { throw new ApiError('protocol', 'invalid_spreadsheet_filter', '行过滤失败，不能导入当前页'); }
    if (!Array.isArray(filtered) || filtered.some((row) => !current.rows.includes(row)) || new Set(filtered).size !== filtered.length) throw new ApiError('protocol', 'invalid_spreadsheet_filter', '过滤只能选择当前只读页的原始行');
  }
  const sourceIndexes = new Map(current.rows.map((row, index): [SpreadsheetRow, number] => [row, current.offset + index]));
  const missingValues: SpreadsheetMissingValue[] = [];
  const rows = filtered.map((row) => Object.fromEntries(copiedFields.map((field): [string, SpreadsheetCell] => {
    const header = mapping[field.key]; const value = header === undefined ? null : row[header] ?? null;
    if (field.required === true && header !== undefined && isEmptyImportCell(value)) missingValues.push({ field_key: field.key, source_row_index: sourceIndexes.get(row) ?? current.offset });
    return [field.key, value];
  })));
  const nextOffset = current.offset + current.rows.length;
  return frozenCopy({ artifact_id: current.artifact_id, source_filename: current.source_filename, sheet_name: current.sheet_name, mapping, rows,
    missing_mappings: missingMappings, missing_values: missingValues, ready: missingMappings.length === 0 && missingValues.length === 0,
    pagination: { total_rows: current.total_rows, offset: current.offset, limit: current.limit, read_rows: current.rows.length,
      filtered_rows: current.rows.length - filtered.length, import_rows: rows.length, next_offset: nextOffset,
      has_more: nextOffset < current.total_rows, full_sheet_read: current.offset === 0 && current.rows.length === current.total_rows } });
}
