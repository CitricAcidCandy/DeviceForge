import { ApiError } from '../../../services/api/index.ts';
import type { PerformanceReading } from '../../../features/performance/index.ts';

export const LIVE_FRAME_LIMITS = Object.freeze({
  intervalMs: 3000,
  frames: 20,
  bytes: 32 * 1024 * 1024,
  singleBytes: 8 * 1024 * 1024,
  associationMs: 5000,
});
export interface CapturedLiveFrame {
  readonly artifactId: string;
  readonly publishedAt: number;
  readonly durationMs: number;
  readonly content: Blob;
}
export interface LiveFrame {
  readonly artifactId: string;
  readonly publishedAt: number;
  readonly durationMs: number;
  readonly url: string;
  readonly bytes: number;
}
export interface LiveFramesSnapshot {
  readonly frames: readonly LiveFrame[];
  readonly active: boolean;
  readonly pending: boolean;
  readonly bytes: number;
  readonly limit: string | null;
  readonly error: unknown;
}
export const EMPTY_LIVE_FRAMES: LiveFramesSnapshot = {
  frames: [], active: false, pending: false, bytes: 0, limit: null, error: null,
};
interface FrameOptions {
  readonly createUrl?: (content: Blob) => string;
  readonly revokeUrl?: (url: string) => void;
  readonly schedule?: (run: () => void, delay: number) => () => void;
  readonly onCleanupError?: (error: ApiError) => void;
}

// 每个性能会话拥有一份有界画面状态；暂停保留历史，销毁撤销全部对象 URL。
export function createLiveFrames(
  capture: (signal: AbortSignal) => Promise<CapturedLiveFrame>,
  options: FrameOptions = {},
) {
  const createUrl = options.createUrl ?? ((content: Blob) => URL.createObjectURL(content));
  const revokeUrl = options.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const schedule = options.schedule ?? ((run: () => void, delay: number) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  });
  const listeners = new Set<(snapshot: LiveFramesSnapshot) => void>();
  let snapshot = EMPTY_LIVE_FRAMES;
  let closed = false;
  let generation = 0;
  let inFlight = false;
  let controller: AbortController | null = null;
  let cancelTimer: (() => void) | null = null;
  function publish(patch: Partial<LiveFramesSnapshot>) {
    if (closed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* 一个订阅者不影响采集资源回收。 */ }
    }
  }
  async function take() {
    if (closed || inFlight || !snapshot.active || snapshot.limit) return;
    inFlight = true;
    const current = ++generation;
    const request = new AbortController();
    controller = request;
    publish({ pending: true, error: null });
    try {
      const captured = await capture(request.signal);
      if (closed || request.signal.aborted || current !== generation || !snapshot.active) return;
      const size = captured.content.size;
      if (size <= 0 || size > LIVE_FRAME_LIMITS.singleBytes)
        throw new ApiError('protocol', 'live_frame_size', '截图为空或超过单张 8 MiB 上限');
      if (snapshot.bytes + size > LIVE_FRAME_LIMITS.bytes) {
        publish({ active: false, limit: '画面已达到 32 MiB 上限，指标采集继续' });
        return;
      }
      const frame: LiveFrame = {
        artifactId: captured.artifactId,
        publishedAt: captured.publishedAt,
        durationMs: captured.durationMs,
        bytes: size,
        url: createUrl(captured.content),
      };
      const frames = [...snapshot.frames, frame];
      const limit = frames.length >= LIVE_FRAME_LIMITS.frames
        ? '画面已达到 20 张上限，指标采集继续'
        : null;
      publish({ frames, bytes: snapshot.bytes + size, limit, active: limit === null });
    } catch (error) {
      const unconfirmed = error instanceof ApiError &&
        ['frame_cancel_unconfirmed', 'frame_submission_unconfirmed'].includes(error.code);
      if (unconfirmed && closed) options.onCleanupError?.(error);
      if (unconfirmed && !closed)
        // 未确认任务停止自动循环并保留原错；容量门禁不承担历史故障锁定。
        publish({ active: false, error });
      else if (!closed && current === generation && !request.signal.aborted)
        publish({ active: false, error });
    } finally {
      inFlight = false;
      if (controller === request) controller = null;
      publish({ pending: false });
      if (!closed && snapshot.active && !snapshot.limit)
        cancelTimer = schedule(() => { cancelTimer = null; void take(); }, LIVE_FRAME_LIMITS.intervalMs);
    }
  }
  function pause() {
    ++generation;
    cancelTimer?.();
    cancelTimer = null;
    controller?.abort();
    publish({ active: false });
  }
  return {
    snapshot: () => snapshot,
    subscribe(listener: (value: LiveFramesSnapshot) => void) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (closed || snapshot.active || snapshot.limit) return;
      publish({ active: true, error: null });
      if (!inFlight) {
        if (snapshot.frames.length > 0)
          cancelTimer = schedule(() => { cancelTimer = null; void take(); }, LIVE_FRAME_LIMITS.intervalMs);
        else void take();
      }
    },
    pause,
    dispose() {
      if (closed) return;
      closed = true;
      pause();
      for (const frame of snapshot.frames) revokeUrl(frame.url);
      listeners.clear();
    },
  };
}

// 产物时间来自服务器，与指标同一时钟；不以浏览器时钟或点序号假装精确帧关联。
export function associateLiveFrames(
  readings: readonly PerformanceReading[],
  frames: readonly LiveFrame[],
): ReadonlyMap<number, { readonly url: string; readonly note: string }> {
  const selected = new Map<number, { frame: LiveFrame; delta: number }>();
  for (const frame of frames) {
    let nearest: PerformanceReading | undefined;
    let delta = Number.POSITIVE_INFINITY;
    for (const reading of readings) {
      const distance = Math.abs(reading.captured_at - frame.publishedAt);
      if (distance < delta) { nearest = reading; delta = distance; }
    }
    if (!nearest || delta > LIVE_FRAME_LIMITS.associationMs) continue;
    const previous = selected.get(nearest.sequence);
    if (!previous || delta < previous.delta) selected.set(nearest.sequence, { frame, delta });
  }
  return new Map([...selected].map(([sequence, { frame, delta }]) => [sequence, {
    url: frame.url,
    note: `设备画面，按产物时间近邻关联；偏差 ${delta} ms，截图请求耗时 ${Math.round(frame.durationMs)} ms，非精确单帧`,
  }]));
}
