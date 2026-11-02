import { registerHooks } from 'node:module';

/** 宿主定向单元只映射 SDK 公开入口，生产插件无源码路径依赖。 */
registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@deviceforge/plugin-sdk'
      ? { url: new URL('../../../src/plugin-sdk/index.ts', import.meta.url).href, shortCircuit: true }
      : next(specifier, context);
  },
});
