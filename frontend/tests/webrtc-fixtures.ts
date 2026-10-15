import type { WebRtcConnectionPort, WebRtcControlPort } from '../src/features/mirroring-streaming/services/webrtc.ts';

export class FakeMediaTrack extends EventTarget implements MediaStreamTrack {
  contentHint = '';
  enabled = true;
  readonly id = 'video-track';
  readonly kind: string;
  readonly label = '测试画面';
  readonly muted = false;
  onended: ((this: MediaStreamTrack, event: Event) => void) | null = null;
  onmute: ((this: MediaStreamTrack, event: Event) => void) | null = null;
  onunmute: ((this: MediaStreamTrack, event: Event) => void) | null = null;
  readyState: MediaStreamTrackState = 'live';
  stopCount = 0;
  constructor(kind = 'video') { super(); this.kind = kind; }
  async applyConstraints(): Promise<void> {}
  clone(): MediaStreamTrack { return new FakeMediaTrack(this.kind); }
  getCapabilities(): MediaTrackCapabilities { return {}; }
  getConstraints(): MediaTrackConstraints { return {}; }
  getSettings(): MediaTrackSettings { return {}; }
  stop() { ++this.stopCount; this.readyState = 'ended'; }
}

export class FakeMediaStream extends EventTarget implements MediaStream {
  readonly id = 'test-stream';
  onaddtrack: ((this: MediaStream, event: MediaStreamTrackEvent) => void) | null = null;
  onremovetrack: ((this: MediaStream, event: MediaStreamTrackEvent) => void) | null = null;
  readonly tracks: MediaStreamTrack[] = [];
  get active() { return this.tracks.some((track) => track.readyState === 'live'); }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  clone(): MediaStream { return new FakeMediaStream(); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getTrackById(trackId: string) { return this.tracks.find((track) => track.id === trackId) ?? null; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  removeTrack(track: MediaStreamTrack) {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
  }
}

export class FakeControlChannel implements WebRtcControlPort {
  label = 'deviceforge.control';
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed = 0;
  private readonly listeners = new Set<() => void>();
  send(value: string) { this.sent.push(value); }
  close() { ++this.closed; this.readyState = 'closed'; this.changed(); }
  onState(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  changed() { for (const listener of this.listeners) listener(); }
}

export class FakeWebRtcConnection implements WebRtcConnectionPort {
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { readonly sdp: string } | null = { sdp: 'answer' };
  closed = 0;
  private readonly tracks = new Set<(track: MediaStreamTrack) => void>();
  private readonly channels = new Set<(channel: WebRtcControlPort) => void>();
  private readonly states = new Set<() => void>();
  private readonly iceStates = new Set<() => void>();
  onTrack(listener: (track: MediaStreamTrack) => void) {
    this.tracks.add(listener);
    return () => { this.tracks.delete(listener); };
  }
  onDataChannel(listener: (channel: WebRtcControlPort) => void) {
    this.channels.add(listener);
    return () => { this.channels.delete(listener); };
  }
  onConnectionState(listener: () => void) {
    this.states.add(listener);
    return () => { this.states.delete(listener); };
  }
  onIceGatheringState(listener: () => void) {
    this.iceStates.add(listener);
    return () => { this.iceStates.delete(listener); };
  }
  async setRemoteDescription(): Promise<void> {}
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'draft' }; }
  async setLocalDescription(): Promise<void> {}
  close() { ++this.closed; }
  emitTrack(track: MediaStreamTrack) { for (const listener of this.tracks) listener(track); }
  emitChannel(channel: WebRtcControlPort) { for (const listener of this.channels) listener(channel); }
  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    for (const listener of this.states) listener();
  }
  get iceListenerCount() { return this.iceStates.size; }
}
