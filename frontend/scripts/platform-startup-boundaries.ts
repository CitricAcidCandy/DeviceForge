import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface PlatformStartupBoundaryOptions {
  readonly frontendRoot: string;
  readonly entry?: string;
}

export interface PlatformStartupViolation {
  readonly code: 'forbidden-runtime-dependency' | 'unresolved-local-import' | 'unreadable-source' | 'invalid-source';
  readonly file: string;
  readonly line: number;
  readonly specifier: string | null;
  readonly target: string | null;
  readonly chain: readonly string[];
  readonly message: string;
}

export interface PlatformStartupBoundaryResult {
  readonly files: readonly string[];
  readonly violations: readonly PlatformStartupViolation[];
}

const codeExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const assetExtensions = new Set(['.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.ico', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.txt', '.html']);
const businessFeatures = new Set(['ai-assistant', 'ai-sdk', 'ai-sdk-streaming', 'ai-streaming', 'performance',
  'frida', 'automation', 'settings', 'package-analysis', 'dex-analysis', 'msgpack', 'interactive-sessions',
  'artifact-browser', 'tool-supply']);

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function forbidden(path: string): boolean {
  const value = path.toLowerCase();
  const stem = value.replace(/\.[cm]?[jt]sx?$/, '');
  if (value.startsWith('src/pages/')) return true;
  if (stem === 'src/app/runtime' || stem === 'src/app/app') return true;
  if (stem.startsWith('src/app/composition/legacy-runtime')) return true;
  if (/^src\/app\/product\/(?:services|legacy-services|legacy-business|app)$/.test(stem)) return true;
  if (/^src\/app\/product\/(?:legacy-pages|advanced)(?:\/|$)/.test(stem)) return true;
  const feature = /^src\/features\/([^/]+)(?:\/|$)/.exec(value)?.[1];
  return feature !== undefined && businessFeatures.has(feature);
}

function runtimeSpecifier(node: ts.Statement): ts.StringLiteral | null {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return null;
    const bindings = clause?.namedBindings;
    if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length &&
        bindings.elements.every((element) => element.isTypeOnly)) return null;
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier : null;
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return null;
    if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length &&
        node.exportClause.elements.every((element) => element.isTypeOnly)) return null;
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier : null;
  }
  if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)) return node.moduleReference.expression;
  return null;
}

async function localModule(root: string, importer: string, specifier: string): Promise<string | null> {
  const base = resolve(dirname(importer), specifier);
  if (!inside(root, base)) return null;
  const extension = extname(base);
  let candidates: readonly string[];
  if (extension === '.js' || extension === '.jsx') {
    const stem = base.slice(0, -extension.length);
    candidates = [`${stem}.ts`, `${stem}.tsx`, base];
  } else if (extension === '.mjs' || extension === '.cjs') {
    candidates = [base.slice(0, -extension.length) + (extension === '.mjs' ? '.mts' : '.cts'), base];
  } else if (!extension) {
    candidates = [...codeExtensions.map((suffix) => base + suffix),
      ...codeExtensions.map((suffix) => resolve(base, `index${suffix}`))];
  } else candidates = [base];
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      const actual = await realpath(candidate);
      return inside(root, actual) ? actual : null;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return null;
}

/** 仅检查本地静态启动图；不解析裸依赖，不执行代码，也不跟随动态 import()。 */
export async function checkPlatformStartupBoundaries(
  options: PlatformStartupBoundaryOptions,
): Promise<PlatformStartupBoundaryResult> {
  let root = resolve(options.frontendRoot);
  const entry = options.entry ?? 'src/app/main.ts';
  const files = new Set<string>();
  const sources = new Map<string, ts.SourceFile>();
  const sourceChains = new Map<string, readonly string[]>();
  const visited = new Set<string>();
  const violations: PlatformStartupViolation[] = [];
  const display = (path: string): string => relative(root, path).split(sep).join('/');
  try { root = await realpath(root); }
  catch (error) {
    return { files: [], violations: [{ code: 'unreadable-source', file: entry, line: 1, specifier: null,
      target: entry, chain: [entry], message: `无法读取前端目录：${error instanceof Error ? error.message : String(error)}` }] };
  }

  async function walk(path: string, chain: readonly string[]) {
    let file = display(path);
    let absolute: string;
    try {
      absolute = await realpath(path);
      file = display(absolute);
      if (!inside(root, absolute)) throw new Error('本地静态依赖越过前端目录');
    } catch (error) {
      violations.push({ code: 'unreadable-source', file, line: 1, specifier: null, target: file, chain,
        message: `无法读取静态源码：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (forbidden(file)) {
      violations.push({ code: 'forbidden-runtime-dependency', file, line: 1, specifier: null, target: file,
        chain, message: '平台启动静态图进入旧业务实现或显式兼容入口' });
      return;
    }
    if (visited.has(absolute)) return;
    visited.add(absolute);
    let text: string;
    try { text = await readFile(absolute, 'utf8'); }
    catch (error) {
      violations.push({ code: 'unreadable-source', file, line: 1, specifier: null, target: file, chain,
        message: `无法读取静态源码：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    files.add(file);
    if (!codeExtensions.includes(extname(file)) || /\.d\.[cm]?ts$/.test(file)) {
      if (!assetExtensions.has(extname(file))) violations.push({ code: 'invalid-source', file, line: 1,
        specifier: null, target: file, chain, message: '运行时静态依赖不是可检查的源码或已知静态资源' });
      return;
    }
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
    sources.set(absolute, source);
    sourceChains.set(absolute, chain);
    for (const statement of source.statements) {
      const specifier = runtimeSpecifier(statement);
      if (!specifier || !/^\.{1,2}\//.test(specifier.text)) continue;
      const line = source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1;
      let target: string | null;
      try { target = await localModule(root, absolute, specifier.text); }
      catch (error) {
        violations.push({ code: 'unreadable-source', file, line, specifier: specifier.text,
          target: display(resolve(dirname(absolute), specifier.text)), chain,
          message: `本地静态依赖无法读取：${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const targetName = display(target ?? resolve(dirname(absolute), specifier.text));
      const next = [...chain, targetName];
      if (!target) {
        violations.push({ code: 'unresolved-local-import', file, line, specifier: specifier.text,
          target: targetName, chain: next, message: '本地运行时静态依赖无法解析，不能视为边界检查通过' });
      } else if (forbidden(targetName)) {
        violations.push({ code: 'forbidden-runtime-dependency', file, line, specifier: specifier.text,
          target: targetName, chain: next, message: '平台启动静态图进入旧业务实现或显式兼容入口' });
      } else await walk(target, next);
    }
  }

  const start = resolve(root, entry);
  await walk(start, [display(start)]);
  // 仅用已读 AST 做语法诊断，编译器宿主不能补读或自动解析另一条依赖图。
  const compilerOptions: ts.CompilerOptions = { noResolve: true, noLib: true, allowJs: true,
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (path) => sources.get(resolve(path));
  host.readFile = (path) => sources.get(resolve(path))?.text;
  host.fileExists = (path) => sources.has(resolve(path));
  host.directoryExists = () => false;
  host.getDirectories = () => [];
  host.getCurrentDirectory = () => root;
  const program = ts.createProgram([...sources.keys()], compilerOptions, host);
  for (const [path, source] of sources) {
    for (const diagnostic of program.getSyntacticDiagnostics(source)) {
      const file = display(path);
      violations.push({ code: 'invalid-source', file,
        line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
        specifier: null, target: file, chain: sourceChains.get(path) ?? [file],
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') });
    }
  }
  return { files: [...files].sort(), violations };
}
