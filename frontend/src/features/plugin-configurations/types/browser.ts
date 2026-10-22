import type { JsonValue } from '../../../plugin-sdk/index.ts';

export interface BrowserConfigurationRecord {
  readonly version: number;
  readonly values: { [key: string]: JsonValue };
  readonly revision: string;
  readonly applied: string;
  readonly sensitivePaths: readonly string[];
}
export interface BrowserConfigurationPersistence {
  get(id: string, signal: AbortSignal): Promise<BrowserConfigurationRecord | null>;
  save(
    id: string,
    expectedRevision: string | null,
    record: BrowserConfigurationRecord,
    signal: AbortSignal,
  ): Promise<BrowserConfigurationRecord>;
}
