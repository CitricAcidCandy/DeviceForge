import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspacePluginPackages } from '../scripts/workspace-plugin-packages.ts';

/** 单元测试只按各包公开 development 出口解析；生产插件没有宿主私有路径别名。 */
const aliases = new Map(workspacePluginPackages(fileURLToPath(new URL('..', import.meta.url)))
  .aliases.map(({ find, replacement }) => [find, pathToFileURL(replacement).href]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = aliases.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
