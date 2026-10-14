import type { ApiError, ApiResult, OperationDto } from '../../../shared/api/index.ts';

// 本业务是插件的未知结果契约；宿主任务与操作DTO沿shared索引。
export type SpreadsheetArtifactInput = { readonly artifact_id: string };
export type SpreadsheetReadInput = SpreadsheetArtifactInput & {
  readonly sheet?: string | number;
  readonly offset?: number;
  readonly limit?: number;
};
export type SpreadsheetFormat = 'xlsx' | 'xls' | 'csv';
export type SpreadsheetSheet = { readonly name: string; readonly index: number };
export type SpreadsheetCell = string | number | boolean | null;
export type SpreadsheetRow = Readonly<Record<string, SpreadsheetCell>>;
export type SpreadsheetInspection = SpreadsheetArtifactInput & {
  readonly format_version: 1;
  readonly source_filename: string;
  readonly format: SpreadsheetFormat;
  readonly sheets: readonly SpreadsheetSheet[];
};
export type SpreadsheetPage = SpreadsheetInspection & {
  readonly sheet_name: string;
  readonly headers: readonly string[];
  readonly rows: readonly SpreadsheetRow[];
  readonly total_rows: number;
  readonly offset: number;
  readonly limit: number;
};
export interface SpreadsheetOperationReader { readonly list: (signal: AbortSignal) => Promise<ApiResult<readonly OperationDto[]>> }
export interface SpreadsheetCatalogSnapshot {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly refreshing: boolean;
  readonly logId: string | null;
  readonly error: ApiError | null;
}
export type SpreadsheetImportField = {
  readonly key: string;
  readonly label: string;
  readonly required?: boolean;
  readonly description?: string;
};
export type SpreadsheetFieldMapping = Readonly<Record<string, string | undefined>>;
export type SpreadsheetMissingValue = { readonly field_key: string; readonly source_row_index: number };
export type SpreadsheetImportOptions = {
  readonly defaultMapping?: SpreadsheetFieldMapping;
  readonly previousMapping?: SpreadsheetFieldMapping;
  readonly filterRows?: (rows: readonly SpreadsheetRow[]) => readonly SpreadsheetRow[];
};
export type SpreadsheetImportPage = {
  readonly artifact_id: string;
  readonly source_filename: string;
  readonly sheet_name: string;
  readonly mapping: SpreadsheetFieldMapping;
  readonly rows: readonly SpreadsheetRow[];
  readonly missing_mappings: readonly SpreadsheetImportField[];
  readonly missing_values: readonly SpreadsheetMissingValue[];
  readonly ready: boolean;
  readonly pagination: {
    readonly total_rows: number;
    readonly offset: number;
    readonly limit: number;
    readonly read_rows: number;
    readonly filtered_rows: number;
    readonly import_rows: number;
    readonly next_offset: number;
    readonly has_more: boolean;
    readonly full_sheet_read: boolean;
  };
};
