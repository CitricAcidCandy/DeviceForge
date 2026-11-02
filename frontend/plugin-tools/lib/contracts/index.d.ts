import type { GeneratedPluginContracts } from './types.js';
export type { GeneratedPluginContracts, GeneratedPluginService } from './types.js';
/** 从单清单生成明确子集内的公开类型和一次提交适配；不替代发布校验与业务终态查询。 */
export declare function generatePluginContracts(manifest: unknown): GeneratedPluginContracts;
