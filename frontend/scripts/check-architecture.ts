import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { inspectSource } from './source-dependencies.ts';
import { allowedDependency, findCycles } from './architecture-policy.ts';

export async function checkArchitecture(root = fileURLToPath(new URL('../', import.meta.url))) {
  const sourceRoot = join(root, 'src');
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error('TypeScript 配置无法读取');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error('TypeScript 配置无效');
  const graph = new Map<string, string[]>(); const failures: string[] = [];
  const portable = (path: string) => relative(sourceRoot, path).split(sep).join('/');
  async function checkMaintenanceFiles(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { failures.push(`${relative(root, path)}: 维护目录不得通过链接跨工程引用`); continue; }
      if (entry.isDirectory()) { await checkMaintenanceFiles(path); continue; }
      if (/\.(?:js|mjs|cjs)$/.test(entry.name)) failures.push(`${relative(root, path)}: 维护脚本与测试必须使用 TypeScript`);
    }
  }
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { failures.push(`${portable(path)}: 源码目录不得通过链接跨工程引用`); continue; }
      if (entry.isDirectory()) { await scan(path); continue; }
      if (!/\.(?:ts|js|mjs|svelte)$/.test(entry.name)) continue;
      const from = portable(path); const edges: string[] = [];
      if (/\.(?:js|mjs)$/.test(entry.name)) failures.push(`${from}: 维护源码必须使用 TypeScript`);
      let inspection;
      try { inspection = inspectSource(await readFile(path, 'utf8'), path); }
      catch (error) { failures.push(`${from}: 语法解析失败：${error instanceof Error ? error.message : String(error)}`); continue; }
      for (const issue of inspection.issues) {
        if (issue === 'network' && from.startsWith('shared/api/')) continue;
        // 生成模式可能包含 any；此文件只由 Rust 导出器生成，仍检查其导入。
        if (from === 'shared/api/generated.ts' && issue.includes('any')) continue;
        failures.push(`${from}: ${issue === 'network' ? '网络调用只能位于 shared/api 适配器' : issue}`);
      }
      for (const dependency of inspection.dependencies) {
        let target = ts.resolveModuleName(dependency.value, path, parsed.options, ts.sys).resolvedModule?.resolvedFileName;
        if (!target && dependency.value.startsWith('.')) {
          const direct = resolve(dirname(path), dependency.value);
          target = [direct, `${direct}.ts`, `${direct}.js`, `${direct}/index.ts`].find(existsSync);
        }
        if (!target) { failures.push(`${from}:${dependency.line}: 无法解析导入 ${dependency.value}`); continue; }
        if (/(?:^|[\\/])node_modules(?:[\\/])/.test(target)) continue;
        const to = portable(target);
        if (to.startsWith('../') || !allowedDependency(from, to)) failures.push(`${from}:${dependency.line}: 禁止依赖 ${to}`);
        edges.push(to);
      }
      graph.set(from, edges);
    }
  }
  await scan(sourceRoot);
  for (const directory of ['scripts', 'tests']) {
    const path = join(root, directory);
    if (existsSync(path)) await checkMaintenanceFiles(path);
  }
  for (const entry of await readdir(root)) {
    if (/^(?:vite|svelte)\.config\.(?:js|mjs|cjs)$/.test(entry)) failures.push(`${entry}: 维护配置必须使用 TypeScript`);
  }
  failures.push(...findCycles(graph));
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`前端架构门禁通过：${graph.size} 个源码文件，依赖方向、循环与网络边界正确`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkArchitecture(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
