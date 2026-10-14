import { ApiError } from '../../../shared/api/index.ts';
import { decodeEmptyArtifactResult, decimalU64, invalidBusinessResult, jsonObject, onlyKeys, requireJson } from '../../../shared/jobs/index.ts';
import type { createJobRunner, JsonData, JobTicket } from '../../../shared/jobs/index.ts';
import type { SettingsDelete, SettingsWrite } from '../domain/types.ts';
import { requireSettingsInput } from '../domain/rules.ts';

export const remoteSettingSections: readonly string[] = Object.freeze(['deviceInfo', 'distrosInfo', 'iframePageUrl', 'luaCommand', 'packageInfo', 'permissions', 'distroPaySystemsInfo', 'feishuUser', 'dynamicSnalysisHooks', 'packageSDK', 'chillyRoomProjectGroups', 'apkToolUpdateConfig']);
export interface RemoteSettingsWrite extends SettingsWrite { readonly write_local_backup?: boolean }
export interface RemoteSettingsResult { readonly format_version: 1; readonly section: string; readonly value: JsonData; readonly source: 'remote' | 'local'; readonly backup_updated: boolean; readonly revision: string | null; readonly remote_committed: boolean }
function requireRemote(input: SettingsDelete | RemoteSettingsWrite, save: boolean): void {
  if (save) {
    if (!jsonObject(input)) throw new ApiError('protocol', 'invalid_remote_settings_input', '远端保存参数须为合法 JSON 对象');
    const { write_local_backup, ...settings } = input;
    if (Object.hasOwn(input, 'write_local_backup') && typeof write_local_backup !== 'boolean') throw new ApiError('protocol', 'invalid_remote_settings_input', '本地备份开关只能是布尔值');
    requireSettingsInput('set', settings);
  } else {
    requireSettingsInput('delete', input);
  }
  if (!remoteSettingSections.includes(input.section)) throw new ApiError('protocol', 'invalid_remote_settings_input', '远端配置区不在旧服务公开清单中');
}
function decodeRemote(raw: unknown, logId: string | null, section: string, save: boolean, writeLocalBackup?: boolean): RemoteSettingsResult {
  const value = decodeEmptyArtifactResult(raw, '远端设置', logId);
  if (!jsonObject(value) || !onlyKeys(value, ['format_version', 'section', 'value', 'source', 'backup_updated', 'revision', 'remote_committed'])
    || value.format_version !== 1 || value.section !== section || value.value === undefined || value.source !== 'remote' && value.source !== 'local'
    || typeof value.backup_updated !== 'boolean' || value.revision !== null && !decimalU64(value.revision)
    || typeof value.remote_committed !== 'boolean') throw invalidBusinessResult('远端设置', logId);
  if (value.source === 'local' && (save || value.backup_updated || value.revision === null || value.remote_committed)
    || value.source === 'remote' && (value.remote_committed !== save || value.backup_updated !== (value.revision !== null))
    || save && writeLocalBackup === false && value.backup_updated) throw invalidBusinessResult('远端设置', logId);
  return { format_version: 1, section, value: value.value, source: value.source, backup_updated: value.backup_updated, revision: value.revision, remote_committed: value.remote_committed };
}
export function createRemoteSettings(jobs: ReturnType<typeof createJobRunner>) {
  function ticket(value: JobTicket, save: boolean): void {
    if (value.operation !== `plugin.settings.remote.${save ? 'save' : 'load'}`) throw new ApiError('protocol', 'invalid_settings_ticket', '恢复任务与远端设置操作不匹配');
  }
  return {
    loadRemote(input: SettingsDelete, signal: AbortSignal) {
      requireRemote(input, false); const section = input.section;
      return jobs.execute('plugin.settings.remote.load', requireJson(input), signal, (raw, logId) => decodeRemote(raw, logId, section, false));
    },
    saveRemote(input: RemoteSettingsWrite, signal: AbortSignal) {
      requireRemote(input, true); const section = input.section; const writeLocalBackup = input.write_local_backup;
      return jobs.execute('plugin.settings.remote.save', requireJson(input), signal, (raw, logId) => decodeRemote(raw, logId, section, true, writeLocalBackup));
    },
    resumeRemoteLoad(value: JobTicket, input: SettingsDelete, signal: AbortSignal) {
      ticket(value, false); requireRemote(input, false); const section = input.section;
      return jobs.resume(value, signal, (raw, logId) => decodeRemote(raw, logId, section, false));
    },
    resumeRemoteSave(value: JobTicket, input: RemoteSettingsWrite, signal: AbortSignal) {
      ticket(value, true); requireRemote(input, true); const section = input.section; const writeLocalBackup = input.write_local_backup;
      return jobs.resume(value, signal, (raw, logId) => decodeRemote(raw, logId, section, true, writeLocalBackup));
    },
  };
}
