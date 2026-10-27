import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const publicUiEntries = [
  { specifier: 'deviceforge-host', source: 'public-ui-host.ts', output: 'plugin-host.js' },
  { specifier: 'react', source: 'public-ui-react.ts', output: 'plugin-react.js' },
  { specifier: 'react-dom', source: 'public-ui-react-dom.ts', output: 'plugin-react-dom.js' },
  { specifier: 'react-dom/client', source: 'public-ui-react-dom-client.ts', output: 'plugin-react-dom-client.js' },
  { specifier: 'react/jsx-runtime', source: 'public-ui-jsx-runtime.ts', output: 'plugin-jsx-runtime.js' },
  { specifier: 'react/jsx-dev-runtime', source: 'public-ui-jsx-dev-runtime.ts', output: 'plugin-jsx-dev-runtime.js' },
] as const;

export async function generatePublicUi(
  root = fileURLToPath(new URL('../', import.meta.url)),
  check = false,
): Promise<readonly string[]> {
  const changed: string[] = [];
  for (const entry of publicUiEntries) {
    const path = resolve(root, 'src/app', entry.source);
    const source = await readFile(path, 'utf8');
    const result = ts.transpileModule(source, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        newLine: ts.NewLineKind.LineFeed,
      },
    });
    if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
      throw new Error(`界面入口转译失败：${entry.source}`);
    const output = `// 自动生成自 src/app/${entry.source}；禁止手工修改，请运行 node scripts/generate-public-ui.ts。\n${result.outputText}`;
    const destination = resolve(root, 'public', entry.output);
    let previous: string | undefined;
    try {
      previous = await readFile(destination, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    // Git 在 Windows 检出时可能转换行尾；只将真实源码差异视为产物漂移。
    if (previous?.replaceAll('\r\n', '\n') === output) continue;
    changed.push(entry.output);
    if (!check) await writeFile(destination, output, 'utf8');
  }
  if (check && changed.length) throw new Error(`界面入口产物过期：${changed.join('、')}`);
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = await generatePublicUi(undefined, process.argv.includes('--check'));
  console.log(`共享界面入口：${publicUiEntries.length} 项，${changed.length} 项更新`);
}
