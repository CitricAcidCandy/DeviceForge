import type { BrowserPluginBuildOptions, BrowserPluginBuildResult } from './types.js';
/** 固定工具链、独立依赖边界和无破坏输出；不执行插件代码或工程配置。 */
export declare function buildBrowserPlugin(options: BrowserPluginBuildOptions): Promise<BrowserPluginBuildResult>;
