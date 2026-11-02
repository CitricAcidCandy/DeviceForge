import type { ServiceDefinition } from './manifest.js';
/** 仅生成公开类型、元数据和一次 submit；不生成轮询、回执解码或新调用管线。 */
export declare function contractSource(services: readonly ServiceDefinition[]): string;
