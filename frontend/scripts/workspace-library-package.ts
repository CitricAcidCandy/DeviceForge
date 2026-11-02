import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface LibraryExport {
  readonly name: string;
  readonly source: string;
  readonly types: string;
  readonly module: string;
}
export interface WorkspaceLibrary {
  readonly root: string;
  readonly name: string;
  readonly version: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly exports: readonly LibraryExport[];
}
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
export function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function localPath(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.includes('\\') ||
      value.includes('\0') || value.split('/').some((part) => part === '..'))
    throw new Error('开发及发行出口必须留在本包的 src/dist 目录');
  return value;
}

/** 从已有公开出口派生发行身份，不维护第二份业务清单。 */
export async function readWorkspaceLibrary(rootPath: string): Promise<WorkspaceLibrary> {
  const root = resolve(rootPath);
  const metadata: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!record(metadata) || typeof metadata.name !== 'string' ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(metadata.name) || metadata.type !== 'module' ||
      !record(metadata.exports)) throw new Error('独立库缺少有效的名称、ESM 类型或公开出口');
  let version = metadata.version;
  if (version === undefined) {
    const manifest: unknown = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    if (!record(manifest)) throw new Error('开发清单无效');
    version = manifest.version;
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error('本地发行版本无效');
  const exports: LibraryExport[] = [];
  for (const [name, value] of Object.entries(metadata.exports)) {
    if (!/^\.(?:\/[a-zA-Z0-9._/-]+)?$/.test(name) || name.includes('..') ||
        (typeof value !== 'string' && !record(value)))
      throw new Error('发行只接受明确命名的公开出口');
    const source = localPath(typeof value === 'string' ? value : value.development, './src/');
    const derived = `./dist/${source.slice('./src/'.length).replace(/\.tsx?$/, '')}`;
    const types = localPath(typeof value === 'string' ? `${derived}.d.ts` : value.types, './dist/');
    const module = localPath(typeof value === 'string' ? `${derived}.js` : value.import, './dist/');
    const expected = source.slice('./src/'.length).replace(/\.tsx?$/, '');
    if (!/\.tsx?$/.test(source) || types !== `./dist/${expected}.d.ts` || module !== `./dist/${expected}.js`)
      throw new Error('公开出口与源码编译位置不一致');
    exports.push({ name, source, types, module });
  }
  if (!exports.length) throw new Error('独立库没有可发行出口');
  return { root, name: metadata.name, version, metadata, exports };
}

export async function librarySources(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('发行源码不得通过链接读取包外实现');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}

/** 只改模块引用；普通路径字符串及字面量类型必须保留原值。 */
export function rewriteDeclarationImports(text: string): string {
  const source = ts.createSourceFile('library.d.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = new Map<number, { readonly end: number; readonly value: string }>();
  function visit(node: ts.Node) {
    let specifier: ts.StringLiteral | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal;
    else if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression))
      specifier = node.expression;
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) specifier = node.name;
    if (specifier && /^\.{1,2}\//.test(specifier.text) && /\.tsx?$/.test(specifier.text) &&
        !specifier.text.endsWith('.d.ts')) {
      edits.set(specifier.getStart(source), {
        end: specifier.getEnd(), value: JSON.stringify(specifier.text.replace(/\.tsx?$/, '.js')),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let result = text;
  for (const [start, edit] of [...edits].sort(([left], [right]) => right - left))
    result = result.slice(0, start) + edit.value + result.slice(edit.end);
  return result;
}

export function libraryDiagnostics(errors: readonly ts.Diagnostic[], root: string): string {
  return ts.formatDiagnostics(errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  });
}

function dependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value)) throw new Error('发行依赖必须是明确的版本映射');
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string') throw new Error('发行依赖版本无效');
    result[name] = version;
  }
  return result;
}

/** 本地配套包由调用方同时提供，不把仓库相对路径或开发条件带入归档。 */
export function libraryMetadata(library: WorkspaceLibrary, localVersions: Readonly<Record<string, string>>) {
  const runtime = dependencies(library.metadata.dependencies);
  const peers = dependencies(library.metadata.peerDependencies);
  for (const [name, version] of Object.entries(runtime)) {
    if (version.startsWith('file:') || version.startsWith('workspace:')) {
      const local = localVersions[name];
      if (!local) throw new Error(`发行依赖缺少真实配套版本：${name}`);
      runtime[name] = local;
    }
  }
  for (const [name, version] of Object.entries(peers)) {
    if (!version.startsWith('file:') && !version.startsWith('workspace:')) continue;
    const local = localVersions[name];
    if (!local) throw new Error(`发行共享依赖缺少真实配套版本：${name}`);
    peers[name] = local;
  }
  // SDK 提供运行时错误和共享界面，不能作为已被移除的开发依赖假装可用。
  for (const name of ['@deviceforge/plugin-sdk', '@deviceforge/contracts']) {
    if (!record(library.metadata.devDependencies) || !(name in library.metadata.devDependencies)) continue;
    const version = localVersions[name];
    if (!version) throw new Error(`本地发行需要明确的公开配套版本：${name}`);
    peers[name] = version;
  }
  return {
    name: library.name, version: library.version, private: true, type: 'module',
    ...(typeof library.metadata.description === 'string' ? { description: library.metadata.description } : {}),
    exports: Object.fromEntries(library.exports.map((entry) => [entry.name, { types: entry.types, import: entry.module }])),
    ...(Object.keys(runtime).length ? { dependencies: runtime } : {}),
    ...(Object.keys(peers).length ? { peerDependencies: peers } : {}),
    files: ['dist', 'README.md', 'build.json'],
  };
}
