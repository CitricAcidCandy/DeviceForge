import type { ContractJson } from './json.js';
import type { GeneratedPluginService } from './types.js';
export interface ServiceDefinition extends GeneratedPluginService {
    readonly inputSchema: ContractJson;
    readonly outputSchema: ContractJson;
    readonly inputType: string;
    readonly outputType: string;
}
/** 仅校验生成所需的单清单边界，完整发布校验仍由公开打包工具负责。 */
export declare function manifestServices(input: unknown): readonly ServiceDefinition[];
