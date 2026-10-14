import { decodeArtifactEnvelope, invalidBusinessResult, isJsonData, jsonObject, naturalNumber, onlyKeys, requireArtifactNames } from '../../../shared/jobs/index.ts';
import type { PublishedResult } from '../../../shared/jobs/index.ts';
import type { FridaDeployment, FridaProcesses, FridaScriptInput, FridaScriptResult, FridaServerRun, FridaStatus } from './types.ts';
import { boundedFridaText, fridaDuration, fridaPackage, frozenFridaCopy, validFridaUnicode } from './rules.ts';

const pid = (value: unknown): value is number => naturalNumber(value) && value > 0 && value <= 4294967295;
function published<T>(raw: unknown, logId: string | null, guard: (value: unknown) => value is T, names: readonly string[]): PublishedResult<T> {
  const envelope = decodeArtifactEnvelope(raw, 'Frida', logId); requireArtifactNames(envelope, names, 'Frida', logId);
  if (!guard(envelope.result) || envelope.artifacts.some((artifact) => artifact.size > 64 * 1024 * 1024)) throw invalidBusinessResult('Frida', logId);
  return frozenFridaCopy({ result: envelope.result, artifacts: envelope.artifacts });
}
const common = ['operation.json', 'frida.log'];
function deployment(value: unknown): value is FridaDeployment {
  return jsonObject(value) && onlyKeys(value, ['deployed', 'version_output', 'root_required']) && value.deployed === true
    && typeof value.version_output === 'string' && validFridaUnicode(value.version_output) && value.root_required === true;
}
function status(value: unknown): value is FridaStatus {
  return jsonObject(value) && onlyKeys(value, ['installed', 'running', 'pids', 'version_output', 'ownership'])
    && typeof value.installed === 'boolean' && typeof value.running === 'boolean' && typeof value.version_output === 'string' && validFridaUnicode(value.version_output)
    && value.ownership === 'observed_only' && Array.isArray(value.pids) && value.pids.every(pid) && value.running === (value.pids.length > 0);
}
function serverRun(value: unknown): value is FridaServerRun {
  return jsonObject(value) && onlyKeys(value, ['pid', 'process_start_ticks', 'duration_ms', 'cleanup', 'ownership'])
    && pid(value.pid) && value.pid > 1 && naturalNumber(value.process_start_ticks) && value.process_start_ticks > 0
    && fridaDuration(value.duration_ms) && value.cleanup === 'confirmed' && value.ownership === 'invocation';
}
function processes(value: unknown): value is FridaProcesses {
  return jsonObject(value) && onlyKeys(value, ['source', 'processes']) && value.source === 'frida-ps --json' && Array.isArray(value.processes) && value.processes.length <= 65536
    && value.processes.every((entry: unknown) => jsonObject(entry) && onlyKeys(entry, ['pid', 'name']) && pid(entry.pid) && boundedFridaText(entry.name, 4096));
}
function script(value: unknown): value is FridaScriptResult {
  return jsonObject(value) && onlyKeys(value, ['package', 'mode', 'duration_requested_ms', 'cli_timeout_seconds', 'loaded', 'resume', 'notice_count', 'hook_summary', 'cleanup', 'target_process_cleanup'])
    && fridaPackage(value.package) && (value.mode === 'spawn' || value.mode === 'attach') && fridaDuration(value.duration_requested_ms)
    && value.cli_timeout_seconds === Math.ceil(value.duration_requested_ms / 1000) && value.loaded === true
    && value.resume === (value.mode === 'spawn' ? 'cli_default' : 'already_running') && naturalNumber(value.notice_count) && value.notice_count <= 10000
    && Array.isArray(value.hook_summary) && value.hook_summary.length <= 4097 && value.hook_summary.every(isJsonData)
    && value.cleanup === 'direct_cli_confirmed' && value.target_process_cleanup === 'not_claimed';
}
export const decodeDeployment = (value: unknown, logId: string | null) => published(value, logId, deployment, common);
export const decodeStatus = (value: unknown, logId: string | null) => published(value, logId, status, common);
export const decodeProcesses = (value: unknown, logId: string | null) => published(value, logId, processes, common);
export function decodeServerRun(value: unknown, logId: string | null, durationMs: number) {
  const output = published(value, logId, serverRun, common);
  if (output.result.duration_ms !== durationMs) throw invalidBusinessResult('Frida', logId); return output;
}
export function decodeScript(value: unknown, logId: string | null, input: Pick<FridaScriptInput, 'package' | 'mode' | 'duration_ms'>, permissions: boolean) {
  const output = published(value, logId, script, [...common, permissions ? 'permissions.js' : 'script.js', 'notices.jsonl']);
  if (output.result.package !== input.package || output.result.mode !== input.mode || output.result.duration_requested_ms !== input.duration_ms
    || permissions && !output.result.hook_summary.some((entry) => jsonObject(entry) && entry.type === 'summary')) throw invalidBusinessResult('Frida', logId);
  return output;
}
