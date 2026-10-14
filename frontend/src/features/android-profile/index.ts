import { HostError } from '../../plugin-sdk/index.ts';
import { ApiError } from '../../shared/api/index.ts';
import { isRecord } from '../../shared/api/validation.ts';
import { createJobRunner, jsonObject, onlyKeys } from '../../shared/jobs/index.ts';
import type { JobGateway, JobOptions, JobTicket } from '../../shared/jobs/index.ts';
import { decodeProbe, decodeProfileResult } from './results.ts';
import { invalidInput, requirePackage, requireProfileRequest, requireReference } from './rules.ts';
import type { ProfileHost, ProfileReference, ProfileRequest } from './types.ts';

export type * from './types.ts';
export { PROFILE_LIMITS } from './rules.ts';
export { decodeProbe, decodeProfileResult } from './results.ts';
export { decodeProfileIndex } from './index-results.ts';
export { decodeStackSample, decodeStackJsonLines } from './stacks.ts';
export { buildProfileTimeline } from './timeline.ts';
export { buildProfileFolded, decodeProfileFolded, PROFILE_FOLDED_LIMITS } from './folded.ts';
export { buildProfileFlamegraph, PROFILE_FLAMEGRAPH_LIMITS } from './flamegraph.ts';
export type { ProfileFlameWeight, ProfileFlameNodeKind, ProfileFlameOptions, ProfileFlameQuality, ProfileFlameNode, ProfileFlameLayoutNode, ProfileFlamegraph } from './flamegraph.ts';
export { downloadProfileIndex, downloadProfileArchive } from './artifacts.ts';
export { openProfileArchive, downloadAndOpenProfileArchive } from './archive.ts';
export type { OpenedProfileArchive, OpenedProfileFrame } from './archive.ts';
export { JobFailure, JobWaitFailure } from '../../shared/jobs/index.ts';

const probeOperation = 'plugin.android-device.stack.probe';
const recordOperation = 'plugin.android-device.profile.record';
async function publicCall<T>(call: Promise<T>): Promise<T> {
  try { return await call; } catch (error) {
    if (error instanceof HostError) throw new ApiError(error.kind, error.code, error.message, error.status, error.logId, error.retryAfter);
    throw error;
  }
}
// 完整设备引用固定在本实例；提供者换代后必须重建，旧请求由宿主公开准入拒绝。
export function createAndroidProfile(host: ProfileHost, reference: ProfileReference, options: JobOptions = {}) {
  requireReference(reference);
  const devices = host.devices;
  if (!devices) throw new ApiError('protocol', 'device_access_unavailable', '宿主未提供公开设备访问');
  const target = { ...reference };
  const gateway: JobGateway = {
    submit(operation, envelope, signal) {
      if (!isRecord(envelope) || !onlyKeys(envelope, ['device_id', 'input']) || envelope.device_id !== target.localId || !jsonObject(envelope.input)) throw invalidInput();
      const capability = operation === probeOperation ? 'stack.probe' : operation === recordOperation ? 'profile.record' : null;
      if (!capability) throw invalidInput();
      return publicCall(devices.invoke({ providerId: target.providerId, generation: target.generation, deviceId: target.localId,
        capability, version: 1, input: envelope.input }, signal));
    },
    getJob: (id, signal) => publicCall(host.getJob(id, signal)),
    cancelJob: (id, signal) => publicCall(host.cancelJob(id, signal)),
  };
  const runner = createJobRunner(gateway, options);
  const active = (signal: AbortSignal) => AbortSignal.any([signal, host.signal]);
  const ticketFor = (ticket: JobTicket, operation?: string) => {
    if (ticket.operation !== probeOperation && ticket.operation !== recordOperation || operation !== undefined && ticket.operation !== operation) throw invalidInput();
    return ticket;
  };
  host.onDispose(() => runner.dispose());
  return {
    probe(packageId: string, signal: AbortSignal) {
      requirePackage(packageId);
      return runner.execute(probeOperation, { device_id: target.localId, input: { package: packageId } }, active(signal),
        (value, logId) => decodeProbe(value, logId, target.localId, packageId));
    },
    record(request: ProfileRequest, signal: AbortSignal) {
      requireProfileRequest(request);
      const input = { package: request.package, duration_ms: request.duration_ms, interval_ms: request.interval_ms, capture_frames: request.capture_frames ?? true };
      return runner.execute(recordOperation, { device_id: target.localId, input }, active(signal), (value, logId) => {
        const result = decodeProfileResult(value, logId, target.localId, input.package);
        if (!input.capture_frames && (result.result.frame_count !== 0 || result.result.frame_kind === 'scrcpy_sampled_frame' && result.result.frame_status !== 'disabled')) throw new ApiError('protocol', 'unexpected_profile_frames', '未请求画面却返回了画面产物', null, logId);
        return result;
      });
    },
    resumeProbe(ticket: JobTicket, packageId: string, signal: AbortSignal) {
      requirePackage(packageId);
      return runner.resume(ticketFor(ticket, probeOperation), active(signal), (value, logId) => decodeProbe(value, logId, target.localId, packageId));
    },
    resumeRecording(ticket: JobTicket, packageId: string, signal: AbortSignal) {
      requirePackage(packageId);
      return runner.resume(ticketFor(ticket, recordOperation), active(signal), (value, logId) => decodeProfileResult(value, logId, target.localId, packageId));
    },
    query: (ticket: JobTicket, signal: AbortSignal) => runner.query(ticketFor(ticket), active(signal)),
    cancel: (ticket: JobTicket, signal: AbortSignal) => runner.cancel(ticketFor(ticket), active(signal)),
    dispose: () => runner.dispose(),
  };
}
export type AndroidProfile = ReturnType<typeof createAndroidProfile>;
