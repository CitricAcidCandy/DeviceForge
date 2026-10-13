import type { JsonData, PublishedResult } from '../../shared/jobs/index.ts';

export type MsgpackConversionInput = { readonly artifact_id: string };
export type MsgpackFilter =
  | { readonly field: string; readonly operator: 'equals'; readonly value: JsonData }
  | { readonly field: string; readonly operator: 'contains'; readonly value: string }
  | { readonly field: string; readonly operator: 'greater' | 'less'; readonly value: number };
export type MsgpackPageInput = {
  readonly artifact_id: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly filter?: MsgpackFilter;
};
export type MsgpackByIdInput = { readonly artifact_id: string; readonly id: JsonData };
export type MsgpackConversion = {
  readonly format_version: 1;
  readonly source_artifact_id: string;
  readonly filename: 'converted.msgpack' | 'converted.json';
  readonly size: number;
};
export type MsgpackConversionResult = PublishedResult<MsgpackConversion>;
export type MsgpackPage = {
  readonly format_version: 1;
  readonly source_artifact_id: string;
  readonly total: number;
  readonly matched: number;
  readonly offset: number;
  readonly records: readonly JsonData[];
  readonly next_offset: number | null;
};
