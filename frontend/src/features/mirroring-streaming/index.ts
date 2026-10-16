// 功能公开门面；调用者不依赖内部目录布局。
export * from './models/mirroring-streaming.ts';
export * from './models/http-factory.ts';
export * from './models/webrtc-mirroring.ts';
export type { MirroringClipboard, MirroringOwnership, MirroringOwnershipRequest } from './types/index.ts';
export { createMirroringStream } from './services/stream.ts';
export { encodeMirroringControl } from './utils/rules.ts';
export { mirroringH264Codec } from './services/h264.ts';
export { decodeMirroringPcm } from './services/audio.ts';
export type { MirroringVideoEnvironment } from './services/video.ts';
