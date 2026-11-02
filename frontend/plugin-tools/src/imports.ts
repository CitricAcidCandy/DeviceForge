import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { record, sharedModule } from './paths.js';
import type { PluginModuleImports } from './types.js';

export async function outputFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`构建输出不得包含链接：${path}`);
    if (entry.isDirectory()) files.push(...await outputFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`构建输出不是普通文件：${path}`);
  }
  return files.sort();
}
function literal(value: unknown): string | null {
  return record(value) && (value.type === 'Literal' || value.type === 'StringLiteral') &&
    typeof value.value === 'string' ? value.value : null;
}
function moduleUrl(value: unknown): boolean {
  if (!record(value) || value.type !== 'MemberExpression' || !record(value.object) ||
      value.object.type !== 'MetaProperty' || !record(value.object.meta) ||
      value.object.meta.name !== 'import' || !record(value.object.property) ||
      value.object.property.name !== 'meta') return false;
  return value.computed === true ? literal(value.property) === 'url' :
    record(value.property) && value.property.type === 'Identifier' && value.property.name === 'url';
}
export async function inspectOutput(root: string): Promise<readonly PluginModuleImports[]> {
  const files = await outputFiles(root), known = new Set(files), result: PluginModuleImports[] = [];
  for (const file of files.filter((path) => path.endsWith('.js'))) {
    const code = await readFile(join(root, file), 'utf8');
    const imports = new Set<string>(), dynamic = new Set<string>(), assets = new Set<string>();
    function visit(value: unknown): void {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (!record(value)) return;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(String(value.type))) {
        const source = literal(value.source);
        if (source) imports.add(source);
      }
      if (value.type === 'ImportExpression') {
        const source = literal(value.source);
        if (!source) throw new Error(`构建含不可确认的动态导入：${file}`);
        dynamic.add(source);
      }
      if (value.type === 'NewExpression' && record(value.callee) && value.callee.type === 'Identifier' &&
          value.callee.name === 'URL' && Array.isArray(value.arguments) && moduleUrl(value.arguments[1])) {
        const path = literal(value.arguments[0]);
        if (path) assets.add(path);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== 'parent' && child !== null && typeof child === 'object') visit(child);
      }
    }
    visit(parseAst(code, null, file));
    const modules = [...imports, ...dynamic].filter((path) => !sharedModule(path) && !path.startsWith('data:'));
    for (const path of modules) {
      if (!path.startsWith('./') && !path.startsWith('../'))
        throw new Error(`构建残留宿主不能加载的模块或资源：${file} → ${path}`);
    }
    for (const path of [...modules, ...assets]) {
      if (path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(path))
        throw new Error(`构建残留绝对资源地址：${file} → ${path}`);
      const target = posix.normalize(posix.join(posix.dirname(file), path));
      if (target.startsWith('../') || !known.has(target))
        throw new Error(`构建模块或资源缺失：${file} → ${path}`);
    }
    result.push({ file, static: [...imports].sort(), dynamic: [...dynamic].sort(), assets: [...assets].sort() });
  }
  return result;
}
