import { decimalU64, decodeEmptyArtifactResult, invalidBusinessResult, jsonObject, onlyKeys } from '../../shared/jobs/index.ts';
import type { SettingsAction, SettingsResult } from './types.ts';
import { settingIdentity } from './rules.ts';

export function decodeSettingsResult(action: SettingsAction, raw: unknown, logId: string | null, section?: string): SettingsResult {
  const value = decodeEmptyArtifactResult(raw, '设置', logId);
  if (!jsonObject(value) || !onlyKeys(value, ['format_version', 'revision', 'sections', 'section', 'value']) || value.format_version !== 1 || !decimalU64(value.revision)) throw invalidBusinessResult('设置', logId);
  if (value.sections !== undefined && (!jsonObject(value.sections) || Object.keys(value.sections).length > 64 || !Object.keys(value.sections).every(settingIdentity))) throw invalidBusinessResult('设置', logId);
  if (value.section !== undefined && (!settingIdentity(value.section) || section !== undefined && value.section !== section)) throw invalidBusinessResult('设置', logId);
  if (action === 'get' && (value.section !== section || !Object.hasOwn(value, 'value')) || action !== 'get' && !jsonObject(value.sections)) throw invalidBusinessResult('设置', logId);
  // 校验后显式组装，不用断言把 unknown 当作业务结果。
  const result: SettingsResult = {
    format_version: 1, revision: value.revision,
    ...(jsonObject(value.sections) ? { sections: value.sections } : {}),
    ...(typeof value.section === 'string' ? { section: value.section } : {}),
    ...(Object.hasOwn(value, 'value') && value.value !== undefined ? { value: value.value } : {}),
  };
  return result;
}
