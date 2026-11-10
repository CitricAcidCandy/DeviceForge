import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { workspacePluginPackages } from '../scripts/workspace-plugin-packages.ts';

/** 只为内存启动单元解析公开包及 TSX；不替换任何生产业务模块。 */
export function registerCompositionStartupImports() {
  const root = new URL('../', import.meta.url);
  const directory = workspacePluginPackages(fileURLToPath(root));
  const aliases = new Map(directory.aliases.map(({ find, replacement }) =>
    [find, pathToFileURL(replacement).href]));
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = aliases.get(specifier);
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(root.href)) return nextLoad(url, context);
      // 本单元从不渲染视图，样式只作为模块依赖跳过，不作视觉验收。
      if (url.endsWith('.css')) return { format: 'module', source: 'export {};', shortCircuit: true };
      if (!url.endsWith('.tsx')) return nextLoad(url, context);
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    },
  });
  return { diagnostics: directory.diagnostics, dispose: () => hooks.deregister() };
}
