import type { BrowserPluginBuildOptions, BuildInput } from './types.js';
export declare function inside(root: string, path: string): boolean;
export declare function record(value: unknown): value is Record<string, unknown>;
export declare function codePath(value: string): string;
export declare function sharedModule(id: string): boolean;
export declare function rejectUnknownSharedModule(id: string): void;
export declare function validateInput(options: BrowserPluginBuildOptions): Promise<BuildInput>;
