import type { JsonData } from '../../../shared/jobs/index.ts';

export interface SettingsOwner { readonly scope: 'user' | 'workspace'; readonly owner_id: string }
export interface SettingsSection extends SettingsOwner { readonly section: string }
export interface SettingsWrite extends SettingsSection { readonly value: JsonData; readonly expected_revision: string }
export interface SettingsDelete extends SettingsSection { readonly expected_revision: string }
export interface SettingsImport extends SettingsOwner { readonly sections: { [key: string]: JsonData }; readonly expected_revision: string }
export type SettingsAction = 'list' | 'get' | 'set' | 'delete' | 'import';
export interface SettingsResult {
  readonly format_version: 1;
  readonly revision: string;
  readonly sections?: { [key: string]: JsonData };
  readonly section?: string;
  readonly value?: JsonData;
}
