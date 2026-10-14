import {
  decodeEmptyArtifactResult,
  decimalU64,
  invalidBusinessResult,
  jsonObject,
  onlyKeys,
} from '../../../shared/jobs/index.ts';
import {
  aiSdkCharacterCount,
  aiSdkNonempty,
  frozenAiSdkCopy,
  validAiSdkCanonicalThread,
  validAiSdkProject,
} from './rules.ts';
import type {
  AiSdkAssistantInput,
  AiSdkAssistantResult,
  AiSdkRuntimeStatus,
  AiSdkThreadInput,
  AiSdkThreadResult,
  AiSdkTurnInput,
  AiSdkTurnResult,
} from '../types/index.ts';

const turnFields = [
  'provider',
  'sdk_version',
  'project_id',
  'thread_id',
  'text',
  'turns',
  'resource_scope',
];
function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    aiSdkCharacterCount(value) !== null &&
    new TextEncoder().encode(value).length <= 512 * 1024
  );
}
function nullableText(value: unknown): value is string | null {
  return value === null || validText(value);
}
function decodeTurnFields(
  value: Record<string, unknown>,
  logId: string | null,
  input: AiSdkTurnInput,
  fresh: boolean,
): AiSdkTurnResult {
  if (
    value.provider !== 'codex_sdk' ||
    value.sdk_version !== '0.162.1' ||
    value.resource_scope !== 'sdk_worker_proxy_and_cli' ||
    value.project_id !== input.project_id ||
    !validAiSdkCanonicalThread(value.thread_id) ||
    (input.thread_id !== undefined && value.thread_id !== input.thread_id) ||
    !validText(value.text) ||
    !aiSdkNonempty(value.text) ||
    !decimalU64(value.turns) ||
    value.turns === '0' ||
    (fresh && value.turns !== '1')
  )
    throw invalidBusinessResult('AI SDK', logId);
  return Object.freeze({
    provider: 'codex_sdk',
    sdk_version: '0.162.1',
    project_id: input.project_id,
    thread_id: value.thread_id,
    text: value.text,
    turns: value.turns,
    resource_scope: 'sdk_worker_proxy_and_cli',
  });
}
export function decodeAiSdkTurn(
  raw: unknown,
  logId: string | null,
  input: AiSdkTurnInput,
): AiSdkTurnResult {
  const value = decodeEmptyArtifactResult(raw, 'AI SDK', logId);
  if (!jsonObject(value) || !onlyKeys(value, turnFields))
    throw invalidBusinessResult('AI SDK', logId);
  return decodeTurnFields(value, logId, input, input.thread_id === undefined);
}
export function decodeAiSdkStatus(raw: unknown, logId: string | null): AiSdkRuntimeStatus {
  const value = decodeEmptyArtifactResult(raw, 'AI SDK', logId);
  if (
    !jsonObject(value) ||
    !onlyKeys(value, [
      'provider',
      'sdk_version',
      'profile',
      'configured',
      'node_version',
      'cli_version',
      'sdk_loaded',
      'process_scope_qualified',
      'model_verified',
      'ready',
      'projects',
      'reason',
      'resource_scope',
    ]) ||
    value.provider !== 'codex_sdk' ||
    value.sdk_version !== '0.162.1' ||
    value.profile !== 'codex_sdk_ts_0_162_1_node24' ||
    value.resource_scope !== 'sdk_worker_proxy_and_cli' ||
    typeof value.configured !== 'boolean' ||
    !nullableText(value.node_version) ||
    !nullableText(value.cli_version) ||
    typeof value.sdk_loaded !== 'boolean' ||
    typeof value.process_scope_qualified !== 'boolean' ||
    typeof value.model_verified !== 'boolean' ||
    typeof value.ready !== 'boolean' ||
    !Array.isArray(value.projects) ||
    value.projects.length > 64 ||
    !value.projects.every(validAiSdkProject) ||
    new Set(value.projects).size !== value.projects.length ||
    !nullableText(value.reason)
  )
    throw invalidBusinessResult('AI SDK', logId);
  return frozenAiSdkCopy({
    provider: 'codex_sdk',
    sdk_version: '0.162.1',
    profile: 'codex_sdk_ts_0_162_1_node24',
    configured: value.configured,
    node_version: value.node_version,
    cli_version: value.cli_version,
    sdk_loaded: value.sdk_loaded,
    process_scope_qualified: value.process_scope_qualified,
    model_verified: value.model_verified,
    ready: value.ready,
    projects: value.projects,
    reason: value.reason,
    resource_scope: 'sdk_worker_proxy_and_cli',
  });
}
export function decodeAiSdkThread(
  raw: unknown,
  logId: string | null,
  input: AiSdkThreadInput,
  closing: boolean,
): AiSdkThreadResult {
  const value = decodeEmptyArtifactResult(raw, 'AI SDK', logId);
  if (
    !jsonObject(value) ||
    !onlyKeys(value, [
      'provider',
      'sdk_version',
      'profile',
      'project_id',
      'thread_id',
      'turns',
      'closed',
      'uncertain',
      'resource_scope',
    ]) ||
    value.provider !== 'codex_sdk' ||
    value.sdk_version !== '0.162.1' ||
    value.profile !== 'codex_sdk_ts_0_162_1_node24' ||
    value.resource_scope !== 'sdk_worker_proxy_and_cli' ||
    value.project_id !== input.project_id ||
    value.thread_id !== input.thread_id ||
    !validAiSdkCanonicalThread(value.thread_id) ||
    !decimalU64(value.turns) ||
    typeof value.closed !== 'boolean' ||
    typeof value.uncertain !== 'boolean' ||
    (closing && value.closed !== true)
  )
    throw invalidBusinessResult('AI SDK', logId);
  return Object.freeze({
    provider: 'codex_sdk',
    sdk_version: '0.162.1',
    profile: 'codex_sdk_ts_0_162_1_node24',
    project_id: input.project_id,
    thread_id: value.thread_id,
    turns: value.turns,
    closed: value.closed,
    uncertain: value.uncertain,
    resource_scope: 'sdk_worker_proxy_and_cli',
  });
}
export function decodeAiSdkAssistant(
  raw: unknown,
  logId: string | null,
  input: AiSdkAssistantInput,
): AiSdkAssistantResult {
  const value = decodeEmptyArtifactResult(raw, 'AI SDK', logId);
  if (
    !jsonObject(value) ||
    !onlyKeys(value, [...turnFields, 'assistant_turns', 'stream_output']) ||
    (value.assistant_turns !== '1' &&
      value.assistant_turns !== '2' &&
      value.assistant_turns !== '3' &&
      value.assistant_turns !== '4') ||
    value.stream_output !== (input.stream_output ?? false) ||
    value.turns !== value.assistant_turns ||
    (value.stream_output === true && value.assistant_turns !== '1')
  )
    throw invalidBusinessResult('AI SDK', logId);
  const turn = decodeTurnFields(value, logId, { project_id: input.project_id, prompt: '' }, false);
  return Object.freeze({
    ...turn,
    assistant_turns: value.assistant_turns,
    stream_output: value.stream_output,
  });
}
