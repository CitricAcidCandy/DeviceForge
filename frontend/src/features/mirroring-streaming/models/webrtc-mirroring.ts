import { ApiError, createHttpSessionGateway, isSessionDefinitions } from '../../../services/api/index.ts';
import type { ApiClient, ApiResult, SessionGateway, SessionInfo } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { decodeStreamReceipt, normalizeStreamInput } from '../utils/rules.ts';
import type { MirroringControl, MirroringStreamInput } from '../types/index.ts';
import {
  createWebRtcSignalDecoder, decodeWebRtcPage, decodeWebRtcSession, encodeWebRtcAnswer,
  encodeWebRtcControl, WEBRTC_OPEN,
} from '../services/webrtc-signaling.ts';
import { createWebRtcPeer } from '../services/webrtc.ts';
import type { WebRtcConnectionPort } from '../services/webrtc.ts';

export interface WebRtcMirroringOptions {
  readonly pollIntervalMs?: number;
  readonly peerConnectionFactory?: () => RTCPeerConnection;
  readonly connectionFactory?: () => WebRtcConnectionPort;
  readonly mediaStreamFactory?: () => MediaStream;
}

export interface WebRtcMirroringSnapshot {
  readonly definitions: ReturnType<typeof definitionsView> | null;
  readonly session: SessionInfo | null;
  readonly cursor: number;
  readonly epoch: 1;
  readonly status: 'connecting' | 'streaming' | 'audio_unavailable' | null;
  readonly stream: MediaStream | null;
  readonly inputState: 'unknown' | 'writable' | 'uncertain';
  readonly controlReady: boolean;
  readonly opening: boolean;
  readonly releasing: boolean;
  readonly logs: Readonly<Record<string, string | null>>;
  readonly errors: Readonly<Record<string, ApiError>>;
}

function definitionsView(value: unknown) {
  if (!isSessionDefinitions(value) || new Set(value.sessions.map((entry) => entry.id)).size !== value.sessions.length)
    throw new ApiError('protocol', 'mirroring_webrtc_definitions', '投屏会话目录无效');
  return value;
}

function failure(error: unknown, logId: string | null = null): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('network', 'mirroring_webrtc_failed',
    error instanceof Error ? error.message : 'WebRTC 投屏失败', null, logId);
}

function pause(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      reject(new ApiError('cancelled', 'cancelled', 'WebRTC 等待已取消'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancelled);
      resolve();
    }, delay);
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
  });
}

export function createWebRtcMirroring(gateway: SessionGateway, options: WebRtcMirroringOptions = {}) {
  const interval = options.pollIntervalMs ?? 25;
  if (!Number.isInteger(interval) || interval < 1 || interval > 60000)
    throw new ApiError('protocol', 'mirroring_webrtc_interval', 'WebRTC 轮询间隔无效');
  let view: WebRtcMirroringSnapshot = Object.freeze({
    definitions: null, session: null, cursor: 0, epoch: 1, status: null, stream: null,
    inputState: 'unknown', controlReady: false, opening: false, releasing: false, logs: {}, errors: {},
  });
  const listeners = new Set<(snapshot: WebRtcMirroringSnapshot) => void>();
  let generation = 0;
  let controller: AbortController | null = null;
  let peer: ReturnType<typeof createWebRtcPeer> | null = null;
  let inputTail: Promise<void> = Promise.resolve();
  let negotiated = false;
  let controlEnabled = false;
  let releaseTask: Promise<ApiResult<SessionInfo>> | null = null;
  let terminalEvidence: SessionInfo | null = null;
  let closed = false;

  function publish(patch: Partial<WebRtcMirroringSnapshot>) {
    view = Object.freeze({ ...view, ...patch });
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(view); } catch {}
    }
  }
  function log(action: string, logId: string | null) {
    publish({ logs: Object.freeze({ ...view.logs, [action]: logId }) });
  }
  function report(action: string, error: unknown) {
    const converted = failure(error, view.logs[action] ?? null);
    publish({ errors: Object.freeze({ ...view.errors, [action]: converted }) });
    return converted;
  }
  function stopLocal() {
    ++generation;
    controller?.abort();
    controller = null;
    peer?.close();
    peer = null;
    publish({ stream: null, status: null, inputState: 'uncertain', controlReady: false });
  }
  async function sendLine(identity: SessionInfo, bytes: readonly number[], signal: AbortSignal) {
    const task = inputTail.catch(() => {}).then(async () => {
      let lastLogId: string | null = null;
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        const result = await abortable(gateway.send(identity.id, bytes.slice(offset, offset + 8192), signal), signal);
        decodeStreamReceipt(result.data, identity.id, result.logId);
        lastLogId = result.logId;
      }
      return { data: { id: identity.id, accepted: true }, logId: lastLogId };
    });
    inputTail = task.then(() => {}, () => {});
    return task;
  }
  async function negotiate(identity: SessionInfo, sdp: string, signal: AbortSignal, admitted: number) {
    if (peer || negotiated) throw new ApiError('protocol', 'mirroring_webrtc_duplicate_offer', '重复 WebRTC offer');
    const candidate = createWebRtcPeer({
      ...(options.peerConnectionFactory ? { peerConnectionFactory: options.peerConnectionFactory } : {}),
      ...(options.connectionFactory ? { connectionFactory: options.connectionFactory } : {}),
      ...(options.mediaStreamFactory ? { mediaStreamFactory: options.mediaStreamFactory } : {}),
      audio: controlAudio,
      active: () => admitted === generation && !signal.aborted,
      onStream: (stream) => {
        if (admitted === generation && !signal.aborted) publish({ stream });
      },
      onControlReady: (ready) => {
        if (admitted === generation && !signal.aborted) publish({ controlReady: ready });
      },
      onFailure: (error) => {
        if (admitted !== generation || signal.aborted) return;
        report('connection', error);
        void release(new AbortController().signal).catch(() => {});
      },
    });
    peer = candidate;
    const completeSdp = await candidate.answer(sdp, signal);
    if (admitted !== generation || signal.aborted)
      throw new ApiError('cancelled', 'mirroring_webrtc_stale', 'WebRTC 协商已撤销');
    const result = await sendLine(identity, encodeWebRtcAnswer(completeSdp), signal);
    if (admitted !== generation || signal.aborted)
      throw new ApiError('cancelled', 'mirroring_webrtc_stale', 'WebRTC 协商已撤销');
    negotiated = true;
    log('answer', result.logId);
  }
  let controlAudio = false;
  async function consume(identity: SessionInfo, signal: AbortSignal, admitted: number,
    ready: { resolve: () => void; reject: (error: unknown) => void }) {
    const decoder = createWebRtcSignalDecoder();
    let cursor = 0;
    try {
      while (!signal.aborted && admitted === generation) {
        const result = await abortable(gateway.output(identity.id, { after: cursor, limit: 100 }, signal), signal);
        if (admitted !== generation) break;
        const page = decodeWebRtcPage(result.data, identity, cursor, 100, result.logId);
        log('output', result.logId);
        for (const chunk of page.chunks) {
          for (const message of decoder.push(chunk.bytes)) {
            if (message.type === 'offer') {
              await negotiate(identity, message.sdp, signal, admitted);
              ready.resolve();
            } else publish({ status: message.state });
          }
        }
        cursor = page.next_sequence;
        publish({ session: page.session, cursor });
        if (page.session.status === 'stopping') {
          ready.reject(new ApiError('protocol', 'mirroring_webrtc_stopping', 'WebRTC 会话已停止'));
          void release(new AbortController().signal).catch(() => {});
          return;
        }
        if (page.session.status === 'finished' && cursor === page.session.output_sequence) {
          decoder.finish();
          if (!negotiated) throw new ApiError('protocol', 'mirroring_webrtc_no_offer', '会话结束前未收到 WebRTC offer');
          terminalEvidence = page.session;
          stopLocal();
          if (page.session.completion?.cleanup === 'complete') {
            publish({ session: null });
            const reasons = [
              page.session.completion.failure?.message,
              page.session.completion.outcome?.error,
            ].filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
            if (reasons.length)
              report('output', new ApiError('protocol', 'mirroring_webrtc_session_failed',
                reasons.join('；'), null, result.logId));
          } else {
            publish({ session: page.session });
            report('output', new ApiError('protocol', 'mirroring_webrtc_cleanup_failed',
              'WebRTC 会话清理未确认', null, result.logId));
          }
          return;
        }
        if (!page.chunks.length) await pause(signal, negotiated ? Math.max(interval, 500) : interval);
      }
    } catch (error) {
      if (admitted !== generation || signal.aborted) return;
      const converted = report('output', error);
      ready.reject(converted);
      void release(new AbortController().signal).catch(() => {});
    }
  }
  async function release(signal: AbortSignal): Promise<ApiResult<SessionInfo>> {
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '投屏释放等待已取消');
    if (releaseTask) return abortable(releaseTask, signal);
    const identity = view.session ?? terminalEvidence;
    if (!identity) throw new ApiError('protocol', 'mirroring_webrtc_no_session', '没有待释放的 WebRTC 会话');
    let resolveTask!: (result: ApiResult<SessionInfo>) => void;
    let rejectTask!: (error: unknown) => void;
    const pending = new Promise<ApiResult<SessionInfo>>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    releaseTask = pending;
    const worker = (async () => {
      stopLocal();
      publish({ releasing: true, opening: false });
      const timeout = AbortSignal.timeout(15000);
      try {
        let result: ApiResult<unknown>;
        try { result = await gateway.release(identity.id, timeout); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          publish({ session: null, releasing: false });
          return { data: terminalEvidence ?? identity, logId: error.logId };
        }
        let observed = decodeWebRtcSession(result.data, result.logId, identity);
        log('release', result.logId);
        while (observed.status !== 'finished') {
          await pause(timeout, Math.max(interval, 100));
          try {
            const current = await gateway.get(identity.id, timeout);
            observed = decodeWebRtcSession(current.data, current.logId, identity);
            log('release', current.logId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
            publish({ session: null, releasing: false });
            return { data: terminalEvidence ?? identity, logId: result.logId };
          }
          publish({ session: observed });
        }
        if (observed.completion?.cleanup !== 'complete')
          throw new ApiError('protocol', 'mirroring_webrtc_cleanup_failed', 'WebRTC 会话清理未确认', null, view.logs.release ?? null);
        publish({ session: null, releasing: false });
        return { data: observed, logId: result.logId };
      } catch (error) {
        publish({ releasing: false });
        throw report('release', timeout.aborted
          ? new ApiError('network', 'mirroring_webrtc_release_pending', 'WebRTC 释放等待超时，请查询服务端会话', null, view.logs.release ?? null)
          : error);
      }
    })();
    void worker.then(
      (result) => {
        releaseTask = null;
        resolveTask(result);
      },
      (error: unknown) => {
        releaseTask = null;
        rejectTask(error);
      },
    );
    return abortable(pending, signal);
  }
  return {
    snapshot: () => view,
    subscribe(listener: (snapshot: WebRtcMirroringSnapshot) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async refreshDefinitions(signal: AbortSignal) {
      if (closed) throw new ApiError('cancelled', 'mirroring_webrtc_closed', 'WebRTC 投屏实例已关闭');
      try {
        const result = await abortable(gateway.definitions(signal), signal);
        const data = definitionsView(result.data);
        publish({ definitions: data });
        log('definitions', result.logId);
        return { data, logId: result.logId };
      } catch (error) { throw report('definitions', error); }
    },
    async open(input: MirroringStreamInput, signal: AbortSignal) {
      if (closed || view.session || view.opening || releaseTask)
        throw new ApiError('protocol', 'mirroring_webrtc_busy', 'WebRTC 投屏会话仍在使用或释放中');
      if (!view.definitions?.sessions.some((entry) => entry.id === WEBRTC_OPEN))
        throw new ApiError('protocol', 'mirroring_webrtc_unavailable', '请先刷新并确认 WebRTC 投屏能力');
      const normalized = normalizeStreamInput(input);
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '投屏打开等待已取消');
      const admitted = ++generation;
      controlEnabled = normalized.control !== false;
      controlAudio = normalized.audio !== false;
      terminalEvidence = null;
      negotiated = false;
      inputTail = Promise.resolve();
      const lifetime = new AbortController();
      controller = lifetime;
      publish({ opening: true, status: 'connecting', cursor: 0, inputState: 'unknown', controlReady: false,
        errors: {}, stream: null });
      const opening = gateway.open({ operation: WEBRTC_OPEN, input: normalized }, signal);
      void opening.then((late) => {
        if (admitted === generation && !signal.aborted) return;
        try {
          const orphan = decodeWebRtcSession(late.data, late.logId);
          void gateway.release(orphan.id, AbortSignal.timeout(15000)).catch(() => {});
        } catch {}
      }).catch(() => {});
      try {
        const result = await abortable(opening, signal);
        const identity = decodeWebRtcSession(result.data, result.logId);
        if (admitted !== generation) throw new ApiError('cancelled', 'mirroring_webrtc_stale', '投屏打开已撤销');
        publish({ session: identity, inputState: 'writable' });
        log('open', result.logId);
        let resolveReady = () => {};
        let rejectReady = (_error: unknown) => {};
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        void consume(identity, lifetime.signal, admitted, { resolve: resolveReady, reject: rejectReady });
        const timeout = AbortSignal.timeout(30000);
        try {
          const waiting = AbortSignal.any([signal, lifetime.signal, timeout]);
          await abortable(ready, waiting);
          if (!peer) throw new ApiError('protocol', 'mirroring_webrtc_peer_missing', 'WebRTC 媒体连接未建立');
          await peer.waitForReady(waiting, controlEnabled);
        } catch (error) {
          if (timeout.aborted)
            throw new ApiError('network', 'mirroring_webrtc_negotiation_timeout',
              'WebRTC 协商等待超时', null, view.logs.output ?? null);
          throw error;
        }
        publish({ opening: false });
        return { data: identity, logId: result.logId };
      } catch (error) {
        if (admitted !== generation) throw failure(error);
        if (view.session)
          void release(new AbortController().signal).catch(() => {});
        else stopLocal();
        publish({ opening: false });
        throw report('open', error);
      }
    },
    async sendControl(command: MirroringControl, signal: AbortSignal) {
      const identity = view.session;
      if (!identity || !controlEnabled || !negotiated || !view.controlReady || view.status !== 'streaming' ||
        view.inputState !== 'writable' || identity.status !== 'running')
        throw new ApiError('protocol', 'mirroring_webrtc_control_unavailable', 'WebRTC 设备控制尚未就绪');
      try {
        if (signal.aborted) throw new ApiError('cancelled', 'cancelled', 'WebRTC 控制已取消');
        if (!peer) throw new ApiError('protocol', 'mirroring_webrtc_peer_missing', 'WebRTC 控制连接已关闭');
        peer.sendControl(encodeWebRtcControl(command));
        return { data: { id: identity.id, accepted: true }, logId: null };
      } catch (error) {
        throw report('input', error);
      }
    },
    release,
    async dispose() {
      if (closed) return;
      closed = true;
      try {
        if (view.session) await release(new AbortController().signal);
        else stopLocal();
      } finally {
        stopLocal();
        listeners.clear();
      }
    },
  };
}

export function createHttpWebRtcMirroring(client: ApiClient, options: WebRtcMirroringOptions = {}) {
  return createWebRtcMirroring(createHttpSessionGateway(client), options);
}
