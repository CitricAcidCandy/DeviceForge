import { ApiError } from '../../../shared/api/index.ts';
import { decimalU64, isJsonData, jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import type { SettingsAction } from './types.ts';

export const settingIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
export function requireSettingsInput(action: SettingsAction, value: unknown): void {
  const keys = action === 'list' ? ['scope', 'owner_id'] : action === 'get' ? ['scope', 'owner_id', 'section']
    : action === 'import' ? ['scope', 'owner_id', 'sections', 'expected_revision']
    : ['scope', 'owner_id', 'section', 'expected_revision', ...(action === 'set' ? ['value'] : [])];
  if (!jsonObject(value) || !onlyKeys(value, keys) || (value.scope !== 'user' && value.scope !== 'workspace') || !settingIdentity(value.owner_id)
    || action !== 'list' && action !== 'import' && !settingIdentity(value.section)
    || ['set', 'delete', 'import'].includes(action) && !decimalU64(value.expected_revision)
    || action === 'set' && (!Object.hasOwn(value, 'value') || !isJsonData(value.value))) throw invalidInput();
  if (action === 'import' && (!jsonObject(value.sections) || Object.keys(value.sections).length < 1 || Object.keys(value.sections).length > 64
    || !Object.keys(value.sections).every(settingIdentity))) throw invalidInput();
}
function invalidInput(): ApiError {
  return new ApiError('protocol', 'invalid_settings_input', '配置归属、配置区、内容或预期修订无效');
}
