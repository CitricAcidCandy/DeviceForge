import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** 单元测试只解析公开 SDK 入口，发行包仍使用真实的公开开发依赖。 */
registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@deviceforge/plugin-sdk'
      ? { url: new URL('../../../src/plugin-sdk/index.ts', import.meta.url).href, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.tsx'))
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          fileName: url, compilerOptions: {
            target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
          },
        }).outputText,
      };
    return next(url, context);
  },
});
