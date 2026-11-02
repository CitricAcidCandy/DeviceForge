import type { BrowserPluginBuildResult } from './types.js';
export declare const digest: (bytes: Uint8Array | string) => string;
/** 不清空目录；只替换本工具已有产物，失败时回滚本次改动，无关文件和旧块均保留。 */
export declare function commitOutput(stage: string, result: BrowserPluginBuildResult, signal: AbortSignal): Promise<void>;
