import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { inspectSource } from './source-dependencies.mjs';
import { allowedDependency, findCycles } from './architecture-policy.mjs';

export async function checkArchitecture(root = fileURLToPath(new URL('../', import.meta.url))) {
  const sourceRoot = join(root, 'src');
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error('TypeScript 配置无法读取');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error('TypeScript 配置无效');
  const graph = new Map(); const failures = [];
  const portable = (path) => relative(sourceRoot, path).split(sep).join('/');
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { failures.push(`${portable(path)}: 源码目录不得通过链接跨工程引用`); continue; }
      if (entry.isDirectory()) { await scan(path); continue; }
      if (!/\.(?:ts|js|mjs|svelte)$/.test(entry.name)) continue;
      const from = portable(path); const edges = [];
      let inspection;
      try { inspection = inspectSource(await readFile(path, 'utf8'), path); }
      catch (error) { failures.push(`${from}: 语法解析失败：${error.message}`); continue; }
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
  failures.push(...findCycles(graph));
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`前端架构门禁通过：${graph.size} 个源码文件，依赖方向、循环与网络边界正确`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkArchitecture(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
