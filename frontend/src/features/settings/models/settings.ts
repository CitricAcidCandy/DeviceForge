import { ApiError } from '../../../services/api/index.ts';
import { createJobRunner, jsonObject, onlyKeys, requireJson } from '../../../shared/jobs/index.ts';
import type { JobGateway, JobOptions, JobTicket } from '../../../shared/jobs/index.ts';
import { requireSettingsInput } from '../utils/rules.ts';
import { decodeSettingsResult } from '../utils/results.ts';
import { createRemoteSettings } from './remote.ts';
import { convertLegacyFiles } from '../utils/legacy.ts';
import type { SettingsLegacyImport } from '../utils/legacy.ts';
import type { SettingsAction, SettingsDelete, SettingsImport, SettingsOwner, SettingsSection, SettingsWrite } from '../types/index.ts';

export type * from '../types/index.ts';
export type { LegacySettingsFile, SettingsLegacyImport } from '../utils/legacy.ts';
export { convertLegacyFiles, parseLegacyEditorText } from '../utils/legacy.ts';
export type { RemoteSettingsResult, RemoteSettingsWrite } from './remote.ts';
export { remoteSettingSections } from './remote.ts';
export function createSettings(gateway: JobGateway, options: JobOptions = {}) {
  const jobs = createJobRunner(gateway, options);
  const operation = (action: SettingsAction) => `plugin.settings.${action}`;
  function run(action: SettingsAction, input: SettingsOwner | SettingsSection | SettingsWrite | SettingsDelete | SettingsImport, signal: AbortSignal) {
    requireSettingsInput(action, input);
    const section = 'section' in input ? input.section : undefined;
    return jobs.execute(operation(action), requireJson(input), signal, (value, logId) => decodeSettingsResult(action, value, logId, section));
  }
  function checkTicket(action: SettingsAction, ticket: JobTicket): void {
    if (ticket.operation !== operation(action)) throw new ApiError('protocol', 'invalid_settings_ticket', '恢复任务与设置操作不匹配');
  }
  function checkModuleTicket(ticket: JobTicket): void {
    if (!['list', 'get', 'set', 'delete', 'import', 'remote.load', 'remote.save'].some((action) => ticket.operation === `plugin.settings.${action}`)) throw new ApiError('protocol', 'invalid_settings_ticket', '任务不属于设置模块');
  }
  return {
    ...createRemoteSettings(jobs),
    list: (input: SettingsOwner, signal: AbortSignal) => run('list', input, signal),
    get: (input: SettingsSection, signal: AbortSignal) => run('get', input, signal),
    set: (input: SettingsWrite, signal: AbortSignal) => run('set', input, signal),
    delete: (input: SettingsDelete, signal: AbortSignal) => run('delete', input, signal),
    import: (input: SettingsImport, signal: AbortSignal) => run('import', input, signal),
    importLegacy(input: SettingsLegacyImport, signal: AbortSignal) {
      if (!jsonObject(input) || !onlyKeys(input, ['scope', 'owner_id', 'expected_revision', 'files'])) {
        throw new ApiError('protocol', 'invalid_legacy_settings', '旧配置导入参数无效');
      }
      const sections = convertLegacyFiles(input.files);
      return run('import', { scope: input.scope, owner_id: input.owner_id, expected_revision: input.expected_revision, sections }, signal);
    },
    resume(action: SettingsAction, ticket: JobTicket, signal: AbortSignal, section?: string) {
      checkTicket(action, ticket);
      if (action === 'get' && section === undefined) throw new ApiError('protocol', 'invalid_settings_ticket', '恢复配置读取需要原配置区');
      return jobs.resume(ticket, signal, (value, logId) => decodeSettingsResult(action, value, logId, section));
    },
    query(ticket: JobTicket, signal: AbortSignal) { checkModuleTicket(ticket); return jobs.query(ticket, signal); },
    cancel(ticket: JobTicket, signal: AbortSignal) { checkModuleTicket(ticket); return jobs.cancel(ticket, signal); },
    dispose: jobs.dispose,
  };
}
