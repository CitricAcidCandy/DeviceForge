import type {
  ApiError,
  SessionDefinitions,
  SessionInfo,
  SessionOutputQuery,
} from '../../../services/api/index.ts';

export interface MirroringStreamInput {
  readonly device_id: string;
  readonly max_size?: number;
  readonly max_fps?: number;
  readonly video_bit_rate?: number;
  readonly audio?: boolean;
  readonly control?: boolean;
  readonly reconnect_attempts?: number;
}
export type MirroringControl =
  | {
      readonly type: 'touch';
      readonly action: 'down' | 'up' | 'move';
      readonly pointer_id?: number;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly pressure?: number;
    }
  | {
      readonly type: 'key';
      readonly action: 'down' | 'up';
      readonly keycode: number;
      readonly repeat?: number;
      readonly meta_state?: number;
    }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'clipboard'; readonly text: string; readonly paste?: boolean }
  | { readonly type: 'rotate' | 'reset_video' };
export interface MirroringVideoConfig {
  readonly codec: 'h264';
  readonly format: 'annexb';
  readonly width: number;
  readonly height: number;
}
export interface MirroringAudioConfig {
  readonly codec: 'pcm_s16le';
  readonly sample_rate: 48000;
  readonly channels: 2;
}
export interface MirroringStreamStatus {
  readonly state: 'connecting' | 'streaming' | 'reconnecting' | 'audio_unavailable';
  readonly attempt: number;
}
interface PacketIdentity {
  readonly epoch: number;
  readonly timestampUs: number;
}
export type MirroringPacket = PacketIdentity &
  (
    | { readonly kind: 'video_config'; readonly configuration: MirroringVideoConfig }
    | {
        readonly kind: 'video';
        readonly keyFrame: boolean;
        readonly configuration: boolean;
        readonly bytes: Uint8Array;
      }
    | { readonly kind: 'audio_config'; readonly configuration: MirroringAudioConfig }
    | { readonly kind: 'audio'; readonly bytes: Uint8Array }
    | { readonly kind: 'status'; readonly status: MirroringStreamStatus }
  );
export interface MirroringStreamSink {
  readonly packet: (packet: MirroringPacket, signal: AbortSignal) => void | Promise<void>;
  readonly reset?: () => void;
  readonly dispose?: () => void;
}
export type MirroringStreamAction =
  | 'definitions'
  | 'open'
  | 'resume'
  | 'output'
  | 'input'
  | 'eof'
  | 'cancel'
  | 'release';
export type MirroringDefinitionsView = Readonly<
  Omit<SessionDefinitions, 'sessions'> & {
    readonly sessions: readonly Readonly<SessionDefinitions['sessions'][number]>[];
  }
>;
export interface MirroringStreamingSnapshot {
  readonly definitions: MirroringDefinitionsView | null;
  readonly session: Readonly<SessionInfo> | null;
  readonly cursor: number;
  readonly epoch: number;
  readonly status: MirroringStreamStatus | null;
  readonly video: MirroringVideoConfig | null;
  readonly audio: MirroringAudioConfig | null;
  readonly packets: number;
  readonly pendingBytes: number;
  readonly inputState: 'unknown' | 'writable' | 'eof' | 'uncertain';
  readonly pending: readonly MirroringStreamAction[];
  readonly logs: Readonly<Partial<Record<MirroringStreamAction, string | null>>>;
  readonly errors: Readonly<Partial<Record<MirroringStreamAction, ApiError>>>;
}
export interface MirroringStreamingOptions {
  readonly pollIntervalMs?: number;
  readonly sink?: MirroringStreamSink;
}
export type MirroringOutputOptions = Pick<SessionOutputQuery, 'limit'>;
export interface MirroringOutputResult {
  readonly session: Readonly<SessionInfo>;
  readonly cursor: number;
  readonly packets: number;
}
export interface MirroringPacketOutputResult extends MirroringOutputResult {
  readonly mediaPackets: readonly MirroringPacket[];
}
