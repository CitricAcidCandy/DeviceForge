import { registerHooks } from 'node:module';

/** 只供 Node 单元解析本地公开入口，生产插件不通过宿主源码别名取得能力。 */
const aliases = new Map([
  ['@deviceforge/files/model', new URL('../plugins/files/src/model/index.ts', import.meta.url).href],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = aliases.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
