import { manifestServices } from './manifest.js';
import { contractSource } from './source.js';
/** 从单清单生成明确子集内的公开类型和一次提交适配；不替代发布校验与业务终态查询。 */
export function generatePluginContracts(manifest) {
    const definitions = manifestServices(manifest);
    return {
        source: contractSource(definitions),
        services: definitions.map(({ id, version, operation, exportName }) => ({ id, version, operation, exportName })),
    };
}
