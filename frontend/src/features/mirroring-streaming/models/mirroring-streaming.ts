import { ApiError, normalizeSessionId } from '../../../services/api/index.ts';
import type { ApiResult, SessionGateway, SessionInfo } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { createMirroringState } from './state.ts';
import type { MirroringRequest } from './state.ts';
import { createMirroringStream } from '../services/stream.ts';
import {
  copyFrozen,
  decodeStreamDefinitions,
  decodeStreamInfo,
  decodeStreamPage,
  decodeStreamReceipt,
  encodeMirroringControl,
  MIRRORING_OPEN,
  normalizeStreamInput,
  streamError,
  streamPollInterval,
  streamReadLimit,
} from '../utils/rules.ts';
import type {
  MirroringControl,
  MirroringOutputOptions,
  MirroringOutputResult,
  MirroringPacket,
  MirroringPacketOutputResult,
  MirroringStreamInput,
  MirroringStreamingOptions,
} from '../types/index.ts';
export type * from '../types/index.ts';
export { createMirroringFramer } from '../services/framing.ts';
export { createBrowserMirroringSink } from '../services/browser-sink.ts';
export { createMirroringVideoDecoder } from '../services/video.ts';
export { createMirroringAudioPlayer } from '../services/audio.ts';
export { normalizeStreamInput, normalizeMirroringControl } from '../utils/rules.ts';
export function createMirroringStreaming(
  gateway: SessionGateway,
  options: MirroringStreamingOptions = {},
) {
  const state = createMirroringState();
  const stream = createMirroringStream();
  const interval = streamPollInterval(options.pollIntervalMs);
  let controlEnabled = true;
  let clipboardEnabled = false;
  let clipboardSequence = 0;
  let controlReady = false;
  let tainted = false;
  let streamGeneration = 0;
  let closed = false;
  let releaseTask: Promise<ApiResult<SessionInfo>> | null = null;
  async function read(
    context: MirroringRequest,
    request: (signal: AbortSignal) => Promise<ApiResult<unknown>>,
  ): Promise<ApiResult<unknown>> {
    state.assertCurrent(context);
    const result = await abortable(request(context.signal), context.signal);
    state.assertCurrent(context, result.logId);
    return result;
  }
  async function run<T>(
    context: MirroringRequest,
    action: () => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    try {
      const result = await action();
      state.end(context, result.logId);
      return result;
    } catch (error) {
      const failure = streamError(error, state.snapshot().logs[context.action] ?? null);
      state.failure(context, failure);
      throw failure;
    }
  }
  function selected(): Readonly<SessionInfo> {
    const identity = state.snapshot().session;
    if (!identity)
      throw new ApiError('protocol', 'mirroring_not_selected', '请先打开或恢复投屏会话');
    return identity;
  }
  function reset(): void {
    releaseTask = null;
    ++streamGeneration;
    state.reset();
    stream.reset();
    options.sink?.reset?.();
    tainted = false;
    controlReady = false;
    clipboardSequence = 0;
  }
  function merge(session: Readonly<SessionInfo>): Readonly<SessionInfo> {
    const previous = state.snapshot().session;
    if (!previous) return session;
    const rank = { opening: 0, running: 1, stopping: 2, finished: 3 };
    return copyFrozen({
      ...(rank[session.status] >= rank[previous.status] ? session : previous),
      output_sequence: Math.max(previous.output_sequence, session.output_sequence),
    });
  }
  async function output(
    context: MirroringRequest,
    limit: number,
    collect = false,
  ): Promise<ApiResult<MirroringPacketOutputResult>> {
    if (tainted)
      throw new ApiError(
        'protocol',
        'mirroring_stream_restart_required',
        '已撤销的帧交付不可重放，请重新打开直播会话',
      );
    const identity = selected();
    const after = state.snapshot().cursor;
    const admitted = streamGeneration;
    const result = await read(context, (signal) =>
      gateway.output(identity.id, { after, limit }, signal),
    );
    const page = decodeStreamPage(result.data, identity, after, limit, result.logId);
    state.update(context, {}, result.logId);
    let processing = false;
    let packetBytes = 0;
    const mediaPackets: MirroringPacket[] = [];
    try {
      for (const chunk of page.chunks) {
        processing = true;
        for (const packet of stream.push(chunk.bytes)) {
          state.assertCurrent(context, result.logId);
          if (collect && packet.kind !== 'clipboard') {
            const bytes =
              packet.kind === 'video' || packet.kind === 'audio' ? packet.bytes.byteLength : 0;
            packetBytes += bytes;
            if (packetBytes > 4 * 1024 * 1024 + 100 * 8192 || mediaPackets.length >= 32768)
              throw new ApiError(
                'protocol',
                'mirroring_packet_batch_limit',
                '投屏媒体批次超过公开帧或字节限额',
                null,
                result.logId,
              );
            mediaPackets.push(
              packet.kind === 'video' || packet.kind === 'audio'
                ? Object.freeze({ ...packet, bytes: packet.bytes.slice() })
                : packet,
            );
          }
          const previous = state.snapshot();
          const newEpoch = packet.epoch !== previous.epoch;
          if (newEpoch) {
            controlReady = false;
            options.sink?.reset?.();
          }
          if (packet.kind === 'status') {
            if (packet.status.state === 'streaming') controlReady = true;
            else if (packet.status.state === 'connecting' || packet.status.state === 'reconnecting')
              controlReady = false;
          }
          if (options.sink && packet.kind !== 'clipboard')
            await abortable(
              Promise.resolve(options.sink.packet(packet, context.signal)),
              context.signal,
            );
          state.assertCurrent(context, result.logId);
          if (
            newEpoch ||
            packet.kind === 'status' ||
            packet.kind === 'video_config' ||
            packet.kind === 'audio_config' ||
            packet.kind === 'clipboard' && controlEnabled && clipboardEnabled
          )
            state.update(
              context,
              {
                ...(newEpoch ? { epoch: packet.epoch, status: null, video: null, audio: null, clipboard: null } : {}),
                ...(packet.kind === 'status' ? { status: packet.status } : {}),
                ...(packet.kind === 'video_config' ? { video: packet.configuration } : {}),
                ...(packet.kind === 'audio_config' ? { audio: packet.configuration } : {}),
                ...(packet.kind === 'clipboard' && controlEnabled && clipboardEnabled
                  ? { clipboard: Object.freeze({ text: packet.text, sequence: ++clipboardSequence }) } : {}),
              },
              result.logId,
            );
        }
      }
      const session = merge(page.session);
      if (session.status === 'finished' && page.next_sequence === session.output_sequence)
        stream.finish();
      const view = stream.snapshot();
      state.update(
        context,
        {
          session,
          cursor: page.next_sequence,
          packets: view.packets,
          pendingBytes: view.pendingBytes,
          ...(session.status === 'finished' || session.status === 'stopping'
            ? { inputState: 'uncertain', clipboard: null }
            : {}),
        },
        result.logId,
      );
      return {
        data: Object.freeze({
          session,
          cursor: page.next_sequence,
          packets: view.packets,
          mediaPackets: Object.freeze(mediaPackets),
        }),
        logId: result.logId,
      };
    } catch (error) {
      if (processing && admitted === streamGeneration) tainted = true;
      throw streamError(error, result.logId);
    }
  }
  function counts(
    result: ApiResult<MirroringPacketOutputResult>,
  ): ApiResult<MirroringOutputResult> {
    return {
      data: Object.freeze({
        session: result.data.session,
        cursor: result.data.cursor,
        packets: result.data.packets,
      }),
      logId: result.logId,
    };
  }
  function pause(signal: AbortSignal, delay = interval): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        clearTimeout(timer);
        reject(new ApiError('cancelled', 'cancelled', '投屏轮询等待已取消'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancelled);
        resolve();
      }, delay);
      if (signal.aborted) cancelled();
      else signal.addEventListener('abort', cancelled, { once: true });
    });
  }
  return {
    refreshDefinitions(signal: AbortSignal) {
      const context = state.begin('definitions', signal);
      return run(context, async () => {
        const result = await read(context, (active) => gateway.definitions(active));
        const data = decodeStreamDefinitions(result.data, result.logId);
        state.update(context, { definitions: data }, result.logId);
        return { data, logId: result.logId };
      });
    },
    open(input: MirroringStreamInput, signal: AbortSignal) {
      const copied = normalizeStreamInput(input);
      state.assertOpen();
      if (!state.snapshot().definitions?.sessions.some((entry) => entry.id === MIRRORING_OPEN))
        throw new ApiError(
          'protocol',
          'mirroring_stream_unavailable',
          '请先刷新并确认公开投屏直播会话',
        );
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '投屏打开等待已取消');
      reset();
      controlEnabled = copied.control !== false;
      clipboardEnabled = copied.clipboard_autosync === true;
      const context = state.begin('open', signal);
      return run(context, async () => {
        const opening = gateway.open(
          { operation: MIRRORING_OPEN, input: { ...copied } },
          AbortSignal.timeout(15000),
        );
        void opening.then((late) => {
          if (!context.signal.aborted) return;
          try {
            const accepted = decodeStreamInfo(late.data, late.logId);
            void gateway.release(accepted.id, AbortSignal.timeout(15000)).catch(() => {});
          } catch {}
        }, () => {});
        const result = await read(context, () => opening);
        const data = decodeStreamInfo(result.data, result.logId);
        if (data.status !== 'opening' || data.output_sequence !== 0)
          throw new ApiError(
            'protocol',
            'invalid_mirroring_open',
            '投屏打开须返回本代 Opening 记录',
            null,
            result.logId,
          );
        state.update(
          context,
          { session: data, inputState: controlEnabled ? 'writable' : 'eof' },
          result.logId,
        );
        return { data, logId: result.logId };
      });
    },
    resume(id: string, signal: AbortSignal) {
      const requested = normalizeSessionId(id);
      state.assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '投屏恢复等待已取消');
      const previous = state.snapshot().session;
      const existing = previous?.id === requested;
      if (existing && tainted)
        throw new ApiError(
          'protocol',
          'mirroring_stream_restart_required',
          '帧交付已撤销，请重新打开直播会话',
        );
      if (!existing) {
        reset();
        controlEnabled = false;
        clipboardEnabled = false;
      }
      const context = state.begin('resume', signal);
      return run(context, async () => {
        const result = await read(context, (active) => gateway.get(requested, active));
        const data = decodeStreamInfo(
          result.data,
          result.logId,
          existing && previous ? previous : undefined,
        );
        if (data.id !== requested || data.output_sequence < state.snapshot().cursor)
          throw new ApiError(
            'protocol',
            'invalid_mirroring_resume',
            '投屏恢复身份或输出序号回退',
            null,
            result.logId,
          );
        state.update(
          context,
          { session: merge(data), ...(!existing ? { inputState: 'unknown' } : {}) },
          result.logId,
        );
        return { data, logId: result.logId };
      });
    },
    readOutput(readOptions: MirroringOutputOptions, signal: AbortSignal) {
      const limit = streamReadLimit(readOptions);
      const context = state.begin('output', signal);
      return run(context, async () => counts(await output(context, limit)));
    },
    readPackets(readOptions: MirroringOutputOptions, signal: AbortSignal) {
      const limit = streamReadLimit(readOptions);
      const context = state.begin('output', signal);
      return run(context, () => output(context, limit, true));
    },
    pollOutput(readOptions: MirroringOutputOptions, signal: AbortSignal) {
      const limit = streamReadLimit(readOptions);
      const context = state.begin('output', signal);
      return run(context, async () => {
        while (true) {
          const result = await output(context, limit);
          if (
            result.data.session.status === 'finished' &&
            result.data.cursor === result.data.session.output_sequence
          )
            return counts(result);
          if (result.data.cursor >= result.data.session.output_sequence)
            await pause(context.signal);
        }
      });
    },
    sendControl(input: MirroringControl, signal: AbortSignal) {
      state.assertOpen();
      if (!controlReady)
        throw new ApiError(
          'protocol',
          'mirroring_control_not_ready',
          '请先观察到当前连接代次的 Streaming 状态',
        );
      const bytes = encodeMirroringControl(input, state.snapshot().epoch);
      const context = state.begin('input', signal);
      const identity = selected();
      return run(context, async () => {
        const result = await read(context, (active) => gateway.send(identity.id, bytes, active));
        const data = decodeStreamReceipt(result.data, identity.id, result.logId);
        state.update(context, {}, result.logId);
        return { data, logId: result.logId };
      });
    },
    eof(signal: AbortSignal) {
      const context = state.begin('eof', signal);
      const identity = selected();
      clipboardEnabled = false;
      return run(context, async () => {
        const result = await read(context, (active) => gateway.eof(identity.id, active));
        const data = decodeStreamReceipt(result.data, identity.id, result.logId);
        state.update(context, { inputState: 'eof', clipboard: null }, result.logId);
        return { data, logId: result.logId };
      });
    },
    cancel(signal: AbortSignal) {
      const context = state.begin('cancel', signal);
      const identity = selected();
      clipboardEnabled = false;
      return run(context, async () => {
        const result = await read(context, (active) => gateway.cancel(identity.id, active));
        const data = decodeStreamInfo(result.data, result.logId, identity);
        state.update(context, { session: merge(data), inputState: 'uncertain' }, result.logId);
        return { data, logId: result.logId };
      });
    },
    release(signal: AbortSignal): Promise<ApiResult<SessionInfo>> {
      if (signal.aborted)
        return Promise.reject(new ApiError('cancelled', 'cancelled', '投屏释放等待已取消'));
      if (releaseTask) return abortable(releaseTask, signal);
      const identity = selected();
      let resolveTask!: (result: ApiResult<SessionInfo>) => void;
      let rejectTask!: (error: unknown) => void;
      const pending = new Promise<ApiResult<SessionInfo>>((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
      });
      // 先登记任务，再发布释放状态，订阅重入也只会提交一次。
      releaseTask = pending;
      const worker = (async () => {
        const timeout = AbortSignal.timeout(15000);
        const context = state.begin('release', timeout);
        const clearSession = (logId: string | null, error?: ApiError) => {
          state.assertCurrent(context, logId);
          ++streamGeneration;
          controlReady = false;
          stream.reset();
          options.sink?.reset?.();
          state.update(context, {
            session: null, inputState: 'unknown', status: null, video: null, audio: null, clipboard: null,
            cursor: 0, epoch: 0, packets: 0, pendingBytes: 0,
            ...(error ? { errors: Object.freeze({ ...state.snapshot().errors, release: error }) } : {}),
          }, logId);
        };
        return run(context, async () => {
          try {
            let result: ApiResult<unknown>;
            try {
              // 换代仅撤销本地等待，已提交的旧会话释放继续使用独立请求期限。
              result = await read(context, () => gateway.release(identity.id, timeout));
            } catch (error) {
              if (!(error instanceof ApiError) || error.status !== 404) throw error;
              clearSession(error.logId);
              return { data: identity, logId: error.logId };
            }
            const data = decodeStreamInfo(result.data, result.logId, identity);
            const cleanupError = data.status === 'finished' && data.completion?.cleanup !== 'complete'
              ? new ApiError('protocol', 'mirroring_cleanup_failed',
                '会话已结束并释放，历史资源核对尚未完成', null, result.logId)
              : undefined;
            // 已接受释放即可退出本地消费，后台清理不再作为重开的锁。
            clearSession(result.logId, cleanupError);
            return { data, logId: result.logId };
          } catch (error) {
            if (timeout.aborted)
              throw new ApiError(
                'network', 'mirroring_release_pending', '释放请求超时，请查询服务端会话状态',
                null, state.snapshot().logs.release ?? null,
              );
            throw error;
          }
        });
      })();
      void worker.then(
        (result) => {
          if (releaseTask === pending) releaseTask = null;
          resolveTask(result);
        },
        (error: unknown) => {
          if (releaseTask === pending) releaseTask = null;
          rejectTask(error);
        },
      );
      return abortable(pending, signal);
    },
    snapshot: state.snapshot,
    subscribe: state.subscribe,
    dispose() {
      if (closed) return;
      closed = true;
      ++streamGeneration;
      state.dispose();
      stream.reset();
      options.sink?.dispose?.();
    },
  };
}
