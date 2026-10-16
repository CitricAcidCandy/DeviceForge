import { ApiError } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import { isDeviceClipboardText } from '../utils/rules.ts';
import type { MirroringOwnership } from '../types/index.ts';
import { decodeWebRtcOwnership, decodeWebRtcOwnershipResult } from './webrtc-ownership.ts';
import type { WebRtcOwnershipResult } from './webrtc-ownership.ts';

export interface WebRtcControlPort {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  send(value: string): void;
  close(): void;
  onState(listener: () => void): () => void;
  onMessage?(listener: (value: unknown) => void): () => void;
}

export interface WebRtcConnectionPort {
  readonly iceGatheringState: RTCIceGatheringState;
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: { readonly sdp: string } | null;
  onTrack(listener: (track: MediaStreamTrack) => void): () => void;
  onDataChannel(listener: (channel: WebRtcControlPort) => void): () => void;
  onConnectionState(listener: () => void): () => void;
  onIceGatheringState(listener: () => void): () => void;
  setRemoteDescription(sdp: string): Promise<void>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(answer: RTCSessionDescriptionInit): Promise<void>;
  close(): void;
}

export function createBrowserWebRtcConnection(connection: RTCPeerConnection = new RTCPeerConnection()): WebRtcConnectionPort {
  return {
    get iceGatheringState() { return connection.iceGatheringState; },
    get connectionState() { return connection.connectionState; },
    get localDescription() { return connection.localDescription; },
    onTrack(listener) {
      const handler = (event: RTCTrackEvent) => listener(event.track);
      connection.addEventListener('track', handler);
      return () => connection.removeEventListener('track', handler);
    },
    onDataChannel(listener) {
      const handler = (event: RTCDataChannelEvent) => {
        const channel = event.channel;
        listener({
          get label() { return channel.label; },
          get ordered() { return channel.ordered; },
          get maxRetransmits() { return channel.maxRetransmits; },
          get maxPacketLifeTime() { return channel.maxPacketLifeTime; },
          get readyState() { return channel.readyState; },
          get bufferedAmount() { return channel.bufferedAmount; },
          send: (value) => channel.send(value),
          close: () => channel.close(),
          onState(changed) {
            channel.addEventListener('open', changed);
            channel.addEventListener('close', changed);
            channel.addEventListener('error', changed);
            return () => {
              channel.removeEventListener('open', changed);
              channel.removeEventListener('close', changed);
              channel.removeEventListener('error', changed);
            };
          },
          onMessage(receive) {
            const handler = (event: MessageEvent) => receive(event.data);
            channel.addEventListener('message', handler);
            return () => channel.removeEventListener('message', handler);
          },
        });
      };
      connection.addEventListener('datachannel', handler);
      return () => connection.removeEventListener('datachannel', handler);
    },
    onConnectionState(listener) {
      connection.addEventListener('connectionstatechange', listener);
      return () => connection.removeEventListener('connectionstatechange', listener);
    },
    onIceGatheringState(listener) {
      connection.addEventListener('icegatheringstatechange', listener);
      return () => connection.removeEventListener('icegatheringstatechange', listener);
    },
    setRemoteDescription: async (sdp) => connection.setRemoteDescription({ type: 'offer', sdp }),
    createAnswer: () => connection.createAnswer(),
    setLocalDescription: async (answer) => connection.setLocalDescription(answer),
    close: () => connection.close(),
  };
}

export interface WebRtcPeerOptions {
  readonly peerConnectionFactory?: () => RTCPeerConnection;
  readonly connectionFactory?: () => WebRtcConnectionPort;
  readonly mediaStreamFactory?: () => MediaStream;
  readonly audio: boolean;
  readonly active: () => boolean;
  readonly onStream: (stream: MediaStream) => void;
  readonly onFailure: (error: ApiError) => void;
  readonly onControlReady: (ready: boolean) => void;
  readonly onClipboard?: (text: string, controlRevision?: number) => void;
  readonly onOwnership?: (ownership: MirroringOwnership) => void;
  readonly onOwnershipResult?: (result: WebRtcOwnershipResult) => void;
}

export function createWebRtcPeer(options: WebRtcPeerOptions) {
  const connection = options.connectionFactory?.() ??
    createBrowserWebRtcConnection(options.peerConnectionFactory?.());
  const stream = options.mediaStreamFactory?.() ?? new MediaStream();
  const tracks = new Set<MediaStreamTrack>();
  let control: WebRtcControlPort | null = null;
  let unsubscribeChannel: (() => void) | null = null;
  let unsubscribeMessages: (() => void) | null = null;
  let clipboardParts: { sequence: number; total: number; next: number; text: string; bytes: number;
    controlRevision?: number } | null = null;
  let clipboardSequence = 0;
  let clipboardFailed = false;
  let ownership: MirroringOwnership | null = null;
  let closed = false;
  let videoSeen = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<() => void>();
  const active = () => !closed && options.active();
  const ready = () => active() && connection.connectionState === 'connected' &&
    control?.readyState === 'open';
  const channelChanged = () => {
    options.onControlReady(Boolean(ready()));
    for (const waiter of [...waiters]) waiter();
  };

  function dataChannel(candidate: WebRtcControlPort) {
    if (!active()) {
      candidate.close();
      return;
    }
    if (control || candidate.label !== 'deviceforge.control' || !candidate.ordered ||
      candidate.maxRetransmits !== null || candidate.maxPacketLifeTime !== null) {
      candidate.close();
      options.onFailure(new ApiError('protocol', 'mirroring_webrtc_control_channel',
        'WebRTC 控制通道配置无效'));
      return;
    }
    control = candidate;
    unsubscribeChannel = candidate.onState(channelChanged);
    unsubscribeMessages = candidate.onMessage?.((data) => {
      if (!active() || (!options.onClipboard && !options.onOwnership && !options.onOwnershipResult)) return;
      let message: unknown;
      try {
        if (typeof data !== 'string' || data.length > 65536 ||
          new TextEncoder().encode(data).length > 65536)
          throw new Error('invalid clipboard');
        message = JSON.parse(data);
      } catch {
        if (!clipboardFailed) {
          clipboardParts = null;
          clipboardFailed = true;
          options.onFailure(new ApiError('protocol', 'mirroring_webrtc_clipboard_invalid',
            'WebRTC 控制通道消息无效'));
        }
        return;
      }
      if (jsonObject(message) && message.type === 'control_state') {
        try {
          const next = decodeWebRtcOwnership(message);
          if (ownership && next.clientId !== ownership.clientId)
            throw new ApiError('protocol', 'mirroring_webrtc_ownership_invalid', 'WebRTC 控制客户端身份改变');
          if (ownership && next.revision < ownership.revision) return;
          if (ownership && next.controlRevision < ownership.controlRevision)
            throw new ApiError('protocol', 'mirroring_webrtc_ownership_invalid', 'WebRTC 控制修订倒退');
          if (!ownership || next.controlRevision !== ownership.controlRevision) {
            clipboardParts = null;
            clipboardSequence = 0;
          } else if (!next.hasControl) clipboardParts = null;
          ownership = next;
          options.onOwnership?.(next);
        } catch (error) {
          clipboardParts = null;
          options.onFailure(error instanceof ApiError ? error :
            new ApiError('protocol', 'mirroring_webrtc_ownership_invalid', 'WebRTC 控制所有权消息无效'));
        }
        return;
      }
      if (jsonObject(message) && message.type === 'control_result') {
        try { options.onOwnershipResult?.(decodeWebRtcOwnershipResult(message)); }
        catch (error) {
          options.onFailure(error instanceof ApiError ? error :
            new ApiError('protocol', 'mirroring_webrtc_ownership_invalid', 'WebRTC 控制申请回执无效'));
        }
        return;
      }
      if (!options.onClipboard || clipboardFailed) return;
      if (ownership && (!ownership.hasControl || !jsonObject(message) ||
        message.control_revision !== ownership.controlRevision)) {
        return;
      }
      try {
        if (!jsonObject(message) || !onlyKeys(message, ['version', 'type', 'epoch', 'sequence', 'part', 'total', 'text', 'control_revision']) ||
          message.version !== 1 || message.type !== 'clipboard' || message.epoch !== 1 ||
          typeof message.sequence !== 'number' || !Number.isInteger(message.sequence) ||
          message.sequence < 1 || message.sequence > 0xffffffff ||
          typeof message.total !== 'number' || !Number.isInteger(message.total) ||
          message.total < 1 || message.total > 33 ||
          typeof message.part !== 'number' || !Number.isInteger(message.part) ||
          message.part < 0 || message.part >= message.total ||
          (message.control_revision !== undefined && (typeof message.control_revision !== 'number' ||
            !Number.isSafeInteger(message.control_revision) || message.control_revision < 1)) ||
          !isDeviceClipboardText(message.text)) throw new Error('invalid clipboard');
        const bytes = new TextEncoder().encode(message.text).length;
        if (bytes > 8192) throw new Error('invalid clipboard');
        if (!clipboardParts) {
          if (message.part !== 0 || message.sequence <= clipboardSequence)
            throw new Error('invalid clipboard');
          clipboardParts = { sequence: message.sequence, total: message.total, next: 0, text: '', bytes: 0,
            ...(typeof message.control_revision === 'number' ? { controlRevision: message.control_revision } : {}) };
        }
        if (message.sequence !== clipboardParts.sequence || message.total !== clipboardParts.total ||
          message.part !== clipboardParts.next || clipboardParts.bytes + bytes > 262139 ||
          message.control_revision !== clipboardParts.controlRevision)
          throw new Error('invalid clipboard');
        clipboardParts.text += message.text;
        clipboardParts.bytes += bytes;
        ++clipboardParts.next;
        if (clipboardParts.next === clipboardParts.total) {
          const text = clipboardParts.text;
          const controlRevision = clipboardParts.controlRevision;
          clipboardSequence = clipboardParts.sequence;
          clipboardParts = null;
          options.onClipboard(text, ownership ? controlRevision : undefined);
        }
      } catch {
        clipboardParts = null;
        clipboardFailed = true;
        options.onFailure(new ApiError('protocol', 'mirroring_webrtc_clipboard_invalid',
          'WebRTC 设备剪贴板消息无效'));
      }
    }) ?? null;
    channelChanged();
  }

  function track(item: MediaStreamTrack) {
    tracks.add(item);
    if (!active()) {
      item.stop();
      return;
    }
    if (item.kind === 'audio' && !options.audio) {
      item.enabled = false;
      return;
    }
    if (item.kind === 'video') videoSeen = true;
    stream.addTrack(item);
    options.onStream(stream);
    channelChanged();
  }
  function connectionState() {
    channelChanged();
    if (disconnectTimer && connection.connectionState !== 'disconnected') {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    if (!active()) return;
    if (connection.connectionState === 'disconnected' && !disconnectTimer)
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        if (active() && connection.connectionState === 'disconnected')
          options.onFailure(new ApiError('network', 'mirroring_webrtc_disconnected',
            'WebRTC 媒体连接已断开'));
      }, 5000);
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed')
      options.onFailure(new ApiError('network', 'mirroring_webrtc_connection_failed', 'WebRTC 媒体连接失败'));
  }
  const unsubscribeTrack = connection.onTrack(track);
  const unsubscribeDataChannel = connection.onDataChannel(dataChannel);
  const unsubscribeConnection = connection.onConnectionState(connectionState);

  async function iceComplete(signal: AbortSignal): Promise<void> {
    if (connection.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (connection.iceGatheringState !== 'complete') return;
        cleanup();
        resolve();
      };
      const cancelled = () => {
        cleanup();
        reject(new ApiError('cancelled', 'cancelled', 'WebRTC ICE 收集已取消'));
      };
      const unsubscribeIce = connection.onIceGatheringState(changed);
      const cleanup = () => {
        unsubscribeIce();
        signal.removeEventListener('abort', cancelled);
      };
      if (signal.aborted) cancelled();
      else {
        signal.addEventListener('abort', cancelled, { once: true });
        changed();
      }
    });
  }

  return {
    controlReady: ready,
    waitForReady(signal: AbortSignal, requireControl: boolean) {
      return new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (!active()) {
            cancelled();
            return;
          }
          if (connection.connectionState !== 'connected' || !videoSeen ||
            (requireControl && !ready())) return;
          cleanup();
          resolve();
        };
        const cancelled = () => {
          cleanup();
          reject(new ApiError('cancelled', 'cancelled', 'WebRTC 连接等待已取消'));
        };
        const cleanup = () => {
          waiters.delete(changed);
          signal.removeEventListener('abort', cancelled);
        };
        waiters.add(changed);
        if (signal.aborted) cancelled();
        else {
          signal.addEventListener('abort', cancelled, { once: true });
          changed();
        }
      });
    },
    sendControl(bytes: readonly number[]) {
      if (!ready() || !control)
        throw new ApiError('protocol', 'mirroring_webrtc_control_unavailable', 'WebRTC 控制通道尚未就绪');
      if (control.bufferedAmount > 65536)
        throw new ApiError('network', 'mirroring_webrtc_control_backpressure', 'WebRTC 控制通道积压，请稍后操作');
      control.send(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)));
    },
    async answer(sdp: string, signal: AbortSignal) {
      await abortable(connection.setRemoteDescription(sdp), signal);
      const draft = await abortable(connection.createAnswer(), signal);
      await abortable(connection.setLocalDescription(draft), signal);
      await iceComplete(signal);
      if (!active() || signal.aborted)
        throw new ApiError('cancelled', 'mirroring_webrtc_stale', 'WebRTC 协商已撤销');
      const complete = connection.localDescription?.sdp;
      if (!complete)
        throw new ApiError('protocol', 'mirroring_webrtc_answer', '浏览器未生成完整 answer');
      return complete;
    },
    close() {
      if (closed) return;
      closed = true;
      clipboardParts = null;
      ownership = null;
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = null;
      for (const waiter of [...waiters]) waiter();
      waiters.clear();
      unsubscribeTrack();
      unsubscribeDataChannel();
      unsubscribeConnection();
      if (control) {
        unsubscribeChannel?.();
        unsubscribeMessages?.();
        control.close();
      }
      control = null;
      connection.close();
      for (const item of tracks) item.stop();
      tracks.clear();
    },
  };
}
