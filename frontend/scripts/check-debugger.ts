import ts from 'typescript';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = fileURLToPath(new URL('../../examples/browser-debugger/', import.meta.url));
const read = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
if (read.error) throw new Error('前端严格类型配置读取失败');
const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
if (config.errors.length) throw new Error('前端严格类型配置解析失败');
const roots = config.fileNames.filter(path => /[\\/](?:tests[\\/]debugger[^\\/]*|scripts[\\/](?:check-debugger|build-debugger-plugin|freeze-debugger|debugger[^\\/]*))\.tsx?$/.test(path));
roots.push(join(root, 'src/app/debugger-runtime.ts'), join(root, 'src/app/main.ts'));
roots.push(join(root, 'node_modules/vite/client.d.ts'));
async function append(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await append(path);
    else if (/\.tsx?$/.test(entry.name)) roots.push(path);
  }
}
if (ts.sys.directoryExists(join(plugin, 'src'))) await append(join(plugin, 'src'));
const options = { ...config.options, paths: { ...config.options.paths,
  react: [join(root, 'node_modules/@types/react/index.d.ts')],
  'react/*': [join(root, 'node_modules/@types/react/*')],
  'react-dom/*': [join(root, 'node_modules/@types/react-dom/*')],
}, types: ['node'], typeRoots: [join(root, 'node_modules/@types')] };
const program = ts.createProgram([...new Set(roots.map(path => resolve(path)))], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else console.log(`Debugger 定向严格类型检查通过：${roots.length} 个入口及其依赖，未运行全仓测试。`);
