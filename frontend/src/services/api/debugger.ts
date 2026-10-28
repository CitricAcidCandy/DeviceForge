import type { components } from './generated.ts';
import type { ApiClient, Endpoint } from './types.ts';
import { isRecord } from './validation.ts';
import { isSchemaValue } from '../../utils/schema.ts';
import type { SchemaValue } from '../../utils/schema.ts';

export type DebuggerTargetDto = components['schemas']['DebuggerTarget'];
export type DebuggerSessionDto = components['schemas']['DebuggerSession'];
export type DebuggerBridgePluginDto = components['schemas']['DebuggerBridgePlugin'];
export type DebuggerRegistrationDto = components['schemas']['DebuggerBridgeRegistration'];
export type DebuggerHeartbeatDto = components['schemas']['DebuggerBridgeHeartbeat'];
export type DebuggerInstanceDto = components['schemas']['DebuggerBrowserInstance'];
export type DebuggerStatusDto = components['schemas']['DebuggerBridgeStatus'];
export type DebuggerPollDto = components['schemas']['DebuggerBridgePoll'];
export type DebuggerBatchDto = components['schemas']['DebuggerBridgeBatch'];
export type DebuggerAckDto = components['schemas']['DebuggerBridgeAck'];
export type DebuggerReceiptDto = components['schemas']['DebuggerCommandReceipt'];
export type DebuggerToolCallDto = components['schemas']['DebuggerToolCall'];

const tools = new Set(['inspect', 'ui_tree', 'ui_query', 'ui_diff', 'ui_assert', 'ui_action', 'invoke', 'reload', 'report']);
const states = new Set(['queued', 'delivered', 'succeeded', 'failed', 'timed_out_unconfirmed', 'cancelled_unconfirmed']);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const nullableText = (value: unknown) => value === null || nonempty(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;

export function isDebuggerTarget(value: unknown): value is DebuggerTargetDto {
  return isRecord(value) && nonempty(value.plugin_id) && nonempty(value.generation) && nullableText(value.version) &&
    ((value.target_kind === 'browser' && nonempty(value.instance_id)) ||
      (value.target_kind === 'server' && value.instance_id === null));
}
function isSession(value: unknown): value is DebuggerSessionDto {
  return isRecord(value) && nonempty(value.session_id) && isDebuggerTarget(value.target) &&
    ['active', 'closed', 'expired', 'disconnected', 'target_changed'].includes(String(value.state)) && natural(value.idle_ttl_ms);
}
function isPlugin(value: unknown): value is DebuggerBridgePluginDto {
  return isRecord(value) && nonempty(value.plugin_id) && nonempty(value.generation) && nullableText(value.version);
}
function isInstance(value: unknown): value is DebuggerInstanceDto {
  return isRecord(value) && nonempty(value.instance_id) && Array.isArray(value.plugins) &&
    value.plugins.length <= 64 && value.plugins.every(isPlugin) && natural(value.active_sessions) && natural(value.idle_ttl_ms);
}
function isStatus(value: unknown): value is DebuggerStatusDto {
  return isRecord(value) && nonempty(value.instance_id) && Array.isArray(value.active_sessions) &&
    value.active_sessions.length <= 128 && value.active_sessions.every(isSession) && Array.isArray(value.targets) &&
    value.targets.length <= 64 && value.targets.every(isDebuggerTarget);
}
export function isDebuggerBatch(value: unknown): value is DebuggerBatchDto {
  if (!isRecord(value)) return false;
  const commands = value.commands;
  return isStatus(value) && Array.isArray(commands) && commands.length <= 4 &&
    commands.every((item: unknown) => isRecord(item) && nonempty(item.command_id) &&
      nonempty(item.session_id) && isDebuggerTarget(item.target) && tools.has(String(item.tool)) &&
      isSchemaValue(item.parameters) && natural(item.remaining_ms) && item.remaining_ms <= (item.tool === 'reload' ? 30000 : 10000));
}
function isReceipt(value: unknown): value is DebuggerReceiptDto {
  return isRecord(value) && nonempty(value.command_id) && nonempty(value.session_id) &&
    states.has(String(value.state)) && natural(value.timeout_ms);
}
function post<I, O>(path: string, decode: (value: unknown) => value is O): Endpoint<I, O> {
  return { request: (input) => ({ path: `/api/v2/debugger/${path}`, method: 'POST',
    contentType: 'application/json', body: JSON.stringify(input) }), decode };
}
const register = post<DebuggerRegistrationDto, DebuggerInstanceDto>('bridge/register', isInstance);
const heartbeat = post<DebuggerHeartbeatDto, DebuggerStatusDto>('bridge/heartbeat', isStatus);
const poll = post<DebuggerPollDto, DebuggerBatchDto>('bridge/poll', isDebuggerBatch);
const ack = post<DebuggerAckDto, DebuggerReceiptDto>('bridge/ack', isReceipt);
const disconnect = post<{ instance_id: string }, { disconnected: boolean }>('bridge/disconnect',
  (value): value is { disconnected: boolean } => isRecord(value) && value.disconnected === true);
const call = post<DebuggerToolCallDto, SchemaValue>('call', isSchemaValue);

export function createDebuggerGateway(client: ApiClient) {
  return {
    register: (input: DebuggerRegistrationDto, signal: AbortSignal) => client.call(register, input, signal),
    heartbeat: (input: DebuggerHeartbeatDto, signal: AbortSignal) => client.call(heartbeat, input, signal),
    poll: (input: DebuggerPollDto, signal: AbortSignal) => client.call(poll, input, signal),
    acknowledge: (input: DebuggerAckDto, signal: AbortSignal) => client.call(ack, input, signal),
    disconnect: (instance_id: string, signal: AbortSignal) => client.call(disconnect, { instance_id }, signal),
    call: (input: DebuggerToolCallDto, signal: AbortSignal) => client.call(call, input, signal),
  };
}
export type DebuggerGateway = ReturnType<typeof createDebuggerGateway>;
