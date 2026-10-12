import { isRecord } from '../../shared/api/validation.ts';
import { decodeArtifactEnvelope, invalidBusinessResult, jsonObject, naturalNumber, requireArtifactNames } from '../../shared/jobs/index.ts';
import type { JsonData, PublishedResult } from '../../shared/jobs/index.ts';
import type { FridaDeployment, FridaProcesses, FridaScriptInput, FridaScriptResult, FridaServerRun, FridaStatus } from './types.ts';
import { boundedFridaText, fridaDuration, fridaPackage } from './rules.ts';

const pid = (value: unknown): value is number => naturalNumber(value) && value > 0 && value <= 4294967295;
function published<T>(raw: unknown, logId: string | null, guard: (value: unknown) => value is T, names: readonly string[]): PublishedResult<T> {
  const envelope = decodeArtifactEnvelope(raw, 'Frida', logId); requireArtifactNames(envelope, names, 'Frida', logId);
  if (!guard(envelope.result)) throw invalidBusinessResult('Frida', logId);
  return { result: envelope.result, artifacts: envelope.artifacts };
}
const common = ['operation.json', 'frida.log'];
function deployment(value: unknown): value is FridaDeployment {
  return isRecord(value) && value.deployed === true && typeof value.version_output === 'string' && value.root_required === true;
}
function status(value: unknown): value is FridaStatus {
  return isRecord(value) && typeof value.installed === 'boolean' && typeof value.running === 'boolean' && typeof value.version_output === 'string'
    && value.ownership === 'observed_only' && Array.isArray(value.pids) && value.pids.every(pid) && value.running === (value.pids.length > 0);
}
function serverRun(value: unknown): value is FridaServerRun {
  return isRecord(value) && pid(value.pid) && naturalNumber(value.process_start_ticks) && fridaDuration(value.duration_ms) && value.cleanup === 'confirmed' && value.ownership === 'invocation';
}
function processes(value: unknown): value is FridaProcesses {
  return isRecord(value) && value.source === 'frida-ps --json' && Array.isArray(value.processes) && value.processes.length <= 65536
    && value.processes.every((entry: unknown) => isRecord(entry) && pid(entry.pid) && boundedFridaText(entry.name, 4096));
}
function diagnosis(value: unknown): value is { [key: string]: JsonData } {
  if (!jsonObject(value)) return false;
  if (value.type === 'summary') return naturalNumber(value.installed_overloads) && naturalNumber(value.missing_methods);
  if (!boundedFridaText(value.class, 255) || !boundedFridaText(value.method, 255)) return false;
  if (value.type === 'installed') return naturalNumber(value.overloads);
  if (value.type === 'duplicate') return true;
  return (value.type === 'missing' || value.type === 'notice_error') && typeof value.error === 'string';
}
function script(value: unknown): value is FridaScriptResult {
  return isRecord(value) && fridaPackage(value.package) && (value.mode === 'spawn' || value.mode === 'attach') && fridaDuration(value.duration_requested_ms)
    && value.cli_timeout_seconds === Math.ceil(value.duration_requested_ms / 1000) && value.loaded === true
    && value.resume === (value.mode === 'spawn' ? 'cli_default' : 'already_running') && naturalNumber(value.notice_count) && value.notice_count <= 10000
    && Array.isArray(value.hook_summary) && value.hook_summary.length <= 4097 && value.hook_summary.every(diagnosis)
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
    || permissions && !output.result.hook_summary.some((entry) => entry.type === 'summary')) throw invalidBusinessResult('Frida', logId);
  return output;
}
