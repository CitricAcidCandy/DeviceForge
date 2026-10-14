import {
  decodeEmptyArtifactResult,
  invalidBusinessResult,
  jsonObject,
  naturalNumber,
  onlyKeys,
} from '../../../shared/jobs/index.ts';
import { boundedText, byteLength, frozenCopy, validUnicode } from './rules.ts';
import type {
  SpreadsheetArtifactInput,
  SpreadsheetCell,
  SpreadsheetInspection,
  SpreadsheetPage,
  SpreadsheetReadInput,
  SpreadsheetRow,
  SpreadsheetSheet,
} from '../types/index.ts';

const moduleName = 'Excel导入';
const baseKeys = ['format_version', 'artifact_id', 'source_filename', 'format', 'sheets'];
function isSheet(value: unknown): value is SpreadsheetSheet {
  return (
    jsonObject(value) &&
    onlyKeys(value, ['name', 'index']) &&
    boundedText(value.name, 512) &&
    naturalNumber(value.index)
  );
}
function isInspection(value: unknown): value is SpreadsheetInspection {
  if (
    !jsonObject(value) ||
    value.format_version !== 1 ||
    typeof value.artifact_id !== 'string' ||
    !boundedText(value.source_filename, 180) ||
    !(typeof value.format === 'string' && ['xlsx', 'xls', 'csv'].includes(value.format)) ||
    !Array.isArray(value.sheets) ||
    value.sheets.length < 1 ||
    value.sheets.length > 64 ||
    !value.sheets.every((sheet, index) => isSheet(sheet) && sheet.index === index)
  )
    return false;
  const sheets = value.sheets.filter(isSheet);
  return (
    new Set(sheets.map((sheet) => sheet.name)).size === sheets.length &&
    (value.format !== 'csv' || (sheets.length === 1 && sheets[0]?.name === 'CSV'))
  );
}
function isCell(value: unknown): value is SpreadsheetCell {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && validUnicode(value) && byteLength(value) <= 32768)
  );
}
function isRow(value: unknown, headers: readonly string[]): value is SpreadsheetRow {
  return (
    jsonObject(value) &&
    Object.keys(value).length === headers.length &&
    onlyKeys(value, headers) &&
    headers.every((header) => Object.hasOwn(value, header)) &&
    Object.values(value).every(isCell)
  );
}
function isPage(value: unknown): value is SpreadsheetPage {
  if (
    !isInspection(value) ||
    !jsonObject(value) ||
    !boundedText(value.sheet_name, 512) ||
    !Array.isArray(value.headers) ||
    value.headers.length > 256 ||
    !value.headers.every((header) => boundedText(header, 512)) ||
    !Array.isArray(value.rows) ||
    !naturalNumber(value.total_rows) ||
    value.total_rows > 10000 ||
    !naturalNumber(value.offset) ||
    value.offset > 10000 ||
    !naturalNumber(value.limit) ||
    value.limit < 1 ||
    value.limit > 500
  )
    return false;
  const headers: string[] = value.headers.filter(
    (header): header is string => typeof header === 'string',
  );
  return (
    new Set(headers).size === headers.length &&
    value.rows.length === Math.min(value.limit, Math.max(value.total_rows - value.offset, 0)) &&
    (headers.length > 0 || value.total_rows === 0) &&
    value.rows.every((row) => isRow(row, headers))
  );
}
function requireBudget(value: unknown, logId: string | null): void {
  if (!jsonObject(value)) throw invalidBusinessResult(moduleName, logId);
  const serialized = JSON.stringify(value);
  if (byteLength(serialized) > 1024 * 1024) throw invalidBusinessResult(moduleName, logId);
}
export function decodeInspection(
  value: unknown,
  logId: string | null,
  input: SpreadsheetArtifactInput,
): SpreadsheetInspection {
  const raw = decodeEmptyArtifactResult(value, moduleName, logId);
  requireBudget(raw, logId);
  if (
    !jsonObject(raw) ||
    !onlyKeys(raw, baseKeys) ||
    !isInspection(raw) ||
    raw.artifact_id !== input.artifact_id
  )
    throw invalidBusinessResult(moduleName, logId);
  return frozenCopy(raw);
}
export function decodePage(
  value: unknown,
  logId: string | null,
  input: SpreadsheetReadInput,
): SpreadsheetPage {
  const raw = decodeEmptyArtifactResult(value, moduleName, logId);
  requireBudget(raw, logId);
  if (
    !jsonObject(raw) ||
    !onlyKeys(raw, [
      ...baseKeys,
      'sheet_name',
      'headers',
      'rows',
      'total_rows',
      'offset',
      'limit',
    ]) ||
    !isPage(raw) ||
    raw.artifact_id !== input.artifact_id ||
    raw.offset !== (input.offset ?? 0) ||
    raw.limit !== (input.limit ?? 100)
  )
    throw invalidBusinessResult(moduleName, logId);
  const selected =
    typeof input.sheet === 'string'
      ? raw.sheets.find((sheet) => sheet.name === input.sheet)
      : raw.sheets[input.sheet ?? 0];
  if (!selected || selected.name !== raw.sheet_name) throw invalidBusinessResult(moduleName, logId);
  return frozenCopy(raw);
}
// 纯映射入口也必须来自已校验的当前页，不能接受调用者伪造行数或单元格。
export function copySpreadsheetPage(value: SpreadsheetPage): SpreadsheetPage {
  return decodePage({ result: value, artifacts: [] }, null, {
    artifact_id: value.artifact_id,
    sheet: value.sheet_name,
    offset: value.offset,
    limit: value.limit,
  });
}
