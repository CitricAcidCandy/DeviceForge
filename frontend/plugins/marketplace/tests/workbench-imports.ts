import { registerHooks } from 'node:module';

/** 定向单元映射真实公开入口；生产插件不读取宿主源码。 */
const entries: Readonly<Record<string, string>> = {
  '@deviceforge/plugin-sdk': '../../../src/plugin-sdk/index.ts',
  '@deviceforge/business-kit': '../../business-kit/src/index.ts',
  '@deviceforge/business-kit/api': '../../business-kit/src/api/index.ts',
  '@deviceforge/business-kit/jobs': '../../business-kit/src/jobs/index.ts',
  '@deviceforge/business-kit/platform': '../../business-kit/src/platform.ts',
  '@deviceforge/business-kit/workspace': '../../business-kit/src/workspace.ts',
  '@deviceforge/settings/model': '../../settings/src/model/index.ts',
};
registerHooks({
  resolve(specifier, context, next) {
    const path = entries[specifier];
    return path ? { url: new URL(path, import.meta.url).href, shortCircuit: true } : next(specifier, context);
  },
});
