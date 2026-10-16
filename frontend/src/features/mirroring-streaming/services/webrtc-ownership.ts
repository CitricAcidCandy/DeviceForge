import { ApiError } from '../../../services/api/index.ts';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import type { MirroringOwnership } from '../types/index.ts';

const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): ApiError {
  return new ApiError('protocol', 'mirroring_webrtc_ownership_invalid', message);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function createWebRtcOwnershipRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function decodeWebRtcOwnership(value: unknown): MirroringOwnership {
  if (!jsonObject(value) || !onlyKeys(value, [
    'version', 'type', 'epoch', 'revision', 'control_revision', 'client_id', 'owner_id', 'is_master',
    'can_control', 'has_control', 'transitioning', 'blocked', 'requests',
  ]) || value.version !== 1 || value.type !== 'control_state' || value.epoch !== 1 ||
    !revision(value.revision) || !revision(value.control_revision) || !id(value.client_id) ||
    (value.owner_id !== null && !id(value.owner_id)) ||
    typeof value.is_master !== 'boolean' || typeof value.can_control !== 'boolean' ||
    typeof value.has_control !== 'boolean' || typeof value.transitioning !== 'boolean' ||
    typeof value.blocked !== 'boolean' || !Array.isArray(value.requests) || value.requests.length > 64)
    throw invalid('WebRTC 控制所有权消息无效');
  const requests = value.requests.map((request) => {
    if (!jsonObject(request) || !onlyKeys(request, ['client_id', 'is_master']) ||
      !id(request.client_id) || typeof request.is_master !== 'boolean')
      throw invalid('WebRTC 控制申请队列无效');
    return Object.freeze({ clientId: request.client_id, isMaster: request.is_master });
  });
  const clientIds = new Set(requests.map((request) => request.clientId));
  if (clientIds.size !== requests.length)
    throw invalid('WebRTC 控制申请队列重复');
  if (value.owner_id === null && value.has_control)
    throw invalid('WebRTC 控制所有权归属无效');
  if (value.has_control && (value.owner_id !== value.client_id || !value.can_control ||
    value.transitioning || value.blocked))
    throw invalid('WebRTC 控制状态无效');
  return Object.freeze({
    revision: value.revision,
    controlRevision: value.control_revision,
    clientId: value.client_id,
    ownerId: value.owner_id,
    isMaster: value.is_master,
    canControl: value.can_control,
    hasControl: value.has_control,
    transitioning: value.transitioning,
    blocked: value.blocked,
    requests: Object.freeze(requests),
  });
}

export type WebRtcOwnershipCommand =
  | { readonly type: 'control_request' }
  | { readonly type: 'control_respond'; readonly clientId: string; readonly accept: boolean }
  | { readonly type: 'control_reclaim' }
  | { readonly type: 'control_release' };

export interface WebRtcOwnershipResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly error?: string;
}

export function decodeWebRtcOwnershipResult(value: unknown): WebRtcOwnershipResult {
  if (!jsonObject(value) || !onlyKeys(value, ['version', 'type', 'epoch', 'request_id', 'ok', 'error']) ||
    value.version !== 1 || value.type !== 'control_result' || value.epoch !== 1 ||
    !id(value.request_id) || typeof value.ok !== 'boolean' ||
    (value.error !== undefined && (typeof value.error !== 'string' || value.error.length < 1 ||
      value.error.length > 1024 || value.error.includes('\0') || encoder.encode(value.error).length > 4096)) ||
    (value.ok && value.error !== undefined))
    throw invalid('WebRTC 控制申请回执无效');
  return Object.freeze({ requestId: value.request_id, ok: value.ok,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  });
}

export function encodeWebRtcOwnershipCommand(command: WebRtcOwnershipCommand, requestId: string): readonly number[] {
  if (!id(requestId)) throw invalid('WebRTC 控制申请身份无效');
  let message: Record<string, unknown>;
  if (command.type === 'control_respond') {
    if (!id(command.clientId) || typeof command.accept !== 'boolean')
      throw invalid('WebRTC 控制申请响应无效');
    message = { version: 1, epoch: 1, type: command.type, request_id: requestId,
      client_id: command.clientId, accept: command.accept };
  } else {
    message = { version: 1, epoch: 1, type: command.type, request_id: requestId };
  }
  const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
  if (bytes.length > 4096) throw invalid('WebRTC 控制所有权消息过长');
  return [...bytes];
}
