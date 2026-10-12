export interface MirroringRequest { readonly device_id: string; readonly duration_ms: number; readonly max_size?: number; readonly max_fps?: number }
export interface MirroringStatus { readonly available: true; readonly version: string; readonly live_stream: false; readonly recording: true }
export interface MirroringRecording { readonly device_id: string; readonly duration_ms: number; readonly codec: 'h264'; readonly filename: 'screen.mp4'; readonly size: number; readonly live_stream: false }
