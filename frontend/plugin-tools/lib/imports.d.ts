import type { PluginModuleImports } from './types.js';
export declare function outputFiles(root: string, prefix?: string): Promise<string[]>;
export declare function inspectOutput(root: string): Promise<readonly PluginModuleImports[]>;
