import type { HostContext, HostResult, Job, JsonValue } from '@deviceforge/plugin-sdk';

export type JsonData = JsonValue;
export interface SettingsOwner {
  readonly scope: 'user' | 'workspace';
  readonly owner_id: string;
}
export interface SettingsSection extends SettingsOwner { readonly section: string }
export interface SettingsWrite extends SettingsSection {
  readonly value: JsonValue;
  readonly expected_revision: string;
}
export interface SettingsDelete extends SettingsSection { readonly expected_revision: string }
export interface SettingsImport extends SettingsOwner {
  readonly sections: { [key: string]: JsonValue };
  readonly expected_revision: string;
}
export type SettingsAction = 'list' | 'get' | 'set' | 'delete' | 'import';
export interface SettingsResult {
  readonly format_version: 1;
  readonly revision: string;
  readonly sections?: { [key: string]: JsonValue };
  readonly section?: string;
  readonly value?: JsonValue;
}
export type SettingsGateway = Pick<HostContext, 'submit' | 'getJob' | 'cancelJob'>;
export interface SettingsTicket {
  readonly id: string;
  readonly operation: string;
  readonly submitLogId: string | null;
}
export interface SettingsOutcome<T> extends HostResult<T> {
  readonly job: Job;
  readonly submitLogId: string | null;
}
export interface SettingsJobOptions {
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}
