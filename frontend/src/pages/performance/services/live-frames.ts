import type { ProductServices } from '../../../app/product/services.ts';
import type { DeviceCapability, DeviceRef } from '../../../plugin-sdk/index.ts';
import { HostError } from '../../../plugin-sdk/index.ts';
import { sameDevice } from '../../../features/device-apps/index.ts';
import { ApiError } from '../../../services/api/index.ts';
import {
  createJobRunner, decodeArtifactEnvelope, downloadPublishedArtifact,
} from '../../../shared/jobs/index.ts';
import { LIVE_FRAME_LIMITS } from '../models/live-frames.ts';
import type { CapturedLiveFrame } from '../models/live-frames.ts';

export function liveFrameCapability(services: ProductServices, reference: DeviceRef | null): {
  readonly capability: DeviceCapability | null;
  readonly reason: string | null;
} {
  const devices = services.runtime.devices.snapshot();
  const operations = services.runtime.operations.snapshot();
  const unavailable = (reason: string) => ({ capability: null, reason });
  if (!reference || !sameDevice(reference, devices.selection))
    return unavailable('当前所选设备与采集会话来源不同');
  const provider = devices.providers.find((item) =>
    item.id === reference.providerId && item.generation === reference.generation);
  const device = devices.selected;
  if (!provider || !device || device.state !== 'online')
    return unavailable('采集设备离线或提供者代次已失效');
  const capability = provider.definition.capabilities.find((item) =>
    item.id === 'screenshot' && item.version === 1 && item.scope === 'device' && item.access === 'write');
  if (!capability || !device.capabilities.some((item) =>
    item.id === capability.id && item.version === capability.version && item.available))
    return unavailable('当前设备没有可用的截图能力');
  if (operations.pending || !operations.result?.data.some((item) => item.id === capability.operation))
    return unavailable('截图操作目录尚未就绪');
  return { capability, reason: null };
}

export async function captureLiveFrame(
  services: ProductServices,
  reference: DeviceRef,
  signal: AbortSignal,
): Promise<CapturedLiveFrame> {
  if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '画面采样已撤销');
  const gate = liveFrameCapability(services, reference);
  const capability = gate.capability;
  if (!capability) throw new ApiError('protocol', 'frame_unavailable', gate.reason ?? '截图不可用');
  const revoked = new AbortController();
  const active = AbortSignal.any([signal, revoked.signal, AbortSignal.timeout(35000)]);
  const validate = () => {
    if (liveFrameCapability(services, reference).capability?.operation !== capability.operation)
      revoked.abort();
  };
  const unwatchDevices = services.runtime.devices.subscribe(validate);
  const unwatchOperations = services.runtime.operations.subscribe(validate);
  let jobId: string | null = null;
  let completed = false;
  let lastLogId: string | null = null;
  let submissionPending = false;
  let submissionError: unknown = null;
  let cancelling: Promise<unknown> | null = null;
  const cancel = () => {
    if (jobId && !completed && !cancelling) {
      const id = jobId;
      cancelling = (async () => {
        const cleanup = AbortSignal.timeout(5000);
        let result = await services.runtime.tasks.cancel(id, cleanup);
        while (true) {
          lastLogId = result.logId;
          if (result.data.id !== id || result.data.operation !== capability.operation)
            throw new ApiError('protocol', 'invalid_job', '截图清理任务身份不匹配', null, result.logId);
          if (['succeeded', 'failed', 'cancelled'].includes(result.data.status)) {
            completed = true;
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          cleanup.throwIfAborted();
          result = await services.runtime.tasks.get(id, cleanup);
        }
      })();
    }
    // 先登记拒绝处理，最终仍等待并将取消未确认报告给调用方。
    void cancelling?.catch(() => {});
  };
  active.addEventListener('abort', cancel, { once: true });
  const runner = createJobRunner({
    submit: async (_, __, current) => {
      submissionPending = true;
      const result = await services.runtime.devices.invoke({
        providerId: reference.providerId, generation: reference.generation,
        deviceId: reference.localId, capability: capability.id, version: capability.version, input: {},
      }, current).catch((error: unknown) => {
        if ((error instanceof ApiError || error instanceof HostError) &&
          (error.kind === 'network' || error.kind === 'cancelled')) {
          lastLogId = error.logId;
          submissionError = error;
          throw error;
        }
        submissionPending = false;
        throw error;
      });
      submissionPending = false;
      jobId = result.data.id;
      lastLogId = result.logId;
      completed = ['succeeded', 'failed', 'cancelled'].includes(result.data.status);
      if (active.aborted) cancel();
      return result;
    },
    getJob: async (id, current) => {
      const result = await services.runtime.tasks.get(id, current);
      lastLogId = result.logId;
      completed = ['succeeded', 'failed', 'cancelled'].includes(result.data.status);
      return result;
    },
    cancelJob: services.runtime.tasks.cancel,
  });
  const begin = performance.now();
  try {
    validate();
    const result = await runner.execute(capability.operation, {}, active,
      (value, logId) => decodeArtifactEnvelope(value, '性能采样画面', logId));
    const artifact = result.data.artifacts[0];
    if (result.data.artifacts.length !== 1 || !artifact ||
      !['image/png', 'image/jpeg'].includes(artifact.media_type))
      throw new ApiError('protocol', 'invalid_live_frame', '截图任务未发布唯一 PNG 或 JPEG 画面', null, result.logId);
    if (artifact.size <= 0 || artifact.size > LIVE_FRAME_LIMITS.singleBytes)
      throw new ApiError('protocol', 'live_frame_size', '截图为空或超过单张 8 MiB 上限', null, result.logId);
    const downloaded = await downloadPublishedArtifact(
      services.runtime.artifacts, result.data, artifact.filename, active,
    );
    validate();
    if (active.aborted) throw new ApiError('cancelled', 'cancelled', '旧画面结果已撤销', null, downloaded.logId);
    return {
      artifactId: artifact.id, publishedAt: artifact.created_at,
      durationMs: performance.now() - begin, content: downloaded.data,
    };
  } finally {
    active.removeEventListener('abort', cancel);
    // 查询网络失败同样保留取消责任；仅停止浏览器等待不能算服务器任务已收敛。
    cancel();
    runner.dispose();
    unwatchDevices();
    unwatchOperations();
    if (submissionPending && !jobId)
      throw new ApiError('network', 'frame_submission_unconfirmed',
        '截图提交结果未确认（任务 ID 未取得），自动截图已停止；请在任务页核对后手动重试' +
        (submissionError instanceof Error ? `：${submissionError.message}` : ''), null, lastLogId);
    try { await cancelling; } catch (error) {
      throw new ApiError('network', 'frame_cancel_unconfirmed',
        `截图任务取消未确认（任务 ID：${jobId ?? '未取得'}），自动截图已停止；请在任务页核对后手动重试` +
        (error instanceof Error ? `：${error.message}` : ''),
        null, error instanceof ApiError ? error.logId ?? lastLogId : lastLogId);
    }
  }
}
