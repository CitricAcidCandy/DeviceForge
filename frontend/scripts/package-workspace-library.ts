import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { pack } from 'it-tar';
import ts from 'typescript';
import {
  digest, libraryDiagnostics, libraryMetadata, librarySources, readWorkspaceLibrary,
  rewriteDeclarationImports, within,
} from './workspace-library-package.ts';

export interface LibraryDependency {
  readonly version: string;
  readonly declarations: Readonly<Record<string, string>>;
}
export interface LibraryPackageOptions {
  readonly root: string;
  readonly outputRoot?: string;
  readonly dependencies: Readonly<Record<string, LibraryDependency>>;
}
export interface LibraryPackageResult {
  readonly archive: string;
  readonly name: string;
  readonly version: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly string[];
  readonly declarations: Readonly<Record<string, string>>;
  readonly typeFiles: readonly string[];
}

/** 只发行独立库的 ESM 与声明；不是安装包生成器，也不执行宿主构建。 */
export async function packageWorkspaceLibrary(options: LibraryPackageOptions): Promise<LibraryPackageResult> {
  const library = await readWorkspaceLibrary(options.root);
  const source = join(library.root, 'src');
  const outputRoot = resolve(options.outputRoot ?? library.root);
  if (within(source, outputRoot)) throw new Error('发行目录不能覆盖源码');
  const outputDirectory = join(outputRoot, 'dist');
  const files = await librarySources(source);
  const paths: Record<string, string[]> = {};
  const versions: Record<string, string> = {};
  const declarationRoots: string[] = [];
  for (const [name, dependency] of Object.entries(options.dependencies)) {
    versions[name] = dependency.version;
    for (const [subpath, file] of Object.entries(dependency.declarations)) {
      const declaration = resolve(file);
      if (!declaration.endsWith('.d.ts')) throw new Error('配套包只能提供已发行的声明，不得导入宿主源码');
      paths[subpath] = [declaration];
      declarationRoots.push(dirname(declaration));
    }
  }
  const metadata = libraryMetadata(library, versions);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    declaration: true, declarationMap: false, sourceMap: false, rewriteRelativeImportExtensions: true,
    allowImportingTsExtensions: true, rootDir: source, outDir: outputDirectory,
    skipLibCheck: false, types: [], paths, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) throw new Error(libraryDiagnostics(errors, library.root));
  for (const file of program.getSourceFiles()) {
    const path = resolve(file.fileName);
    if (!file.isDeclarationFile && !within(source, path))
      throw new Error('独立库编译读到了包外实现，不能用源码别名冒充发行依赖');
    if (file.isDeclarationFile && !within(source, path) && !path.includes(`${sep}node_modules${sep}`) &&
        !declarationRoots.some((root) => within(root, path)))
      throw new Error('包外声明不属于明确交付的公开依赖');
  }
  const contents = new Map<string, Uint8Array>();
  const emitted = program.emit(undefined, (file, text) => {
    const absolute = resolve(file);
    if (!within(outputDirectory, absolute)) throw new Error('编译输出越过本包 dist 目录');
    const name = relative(outputRoot, absolute).split(sep).join('/');
    contents.set(name, Buffer.from(file.endsWith('.d.ts')
      ? rewriteDeclarationImports(text) : text));
  });
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error(libraryDiagnostics(emitted.diagnostics, library.root));
  const declarations = program.getSourceFiles().filter((file) => file.isDeclarationFile && within(source, resolve(file.fileName)));
  // 编译器不会重新输出输入声明，只收集本次实际解析到的本包声明依赖。
  for (const file of declarations) {
    const name = `dist/${relative(source, resolve(file.fileName)).split(sep).join('/')}`;
    if (contents.has(name)) throw new Error('输入声明与编译输出冲突');
    contents.set(name, Buffer.from(rewriteDeclarationImports(file.text)));
  }
  for (const entry of library.exports) {
    if (!contents.has(entry.types.slice(2)) || !contents.has(entry.module.slice(2)))
      throw new Error(`公开出口未实际生成：${entry.name}`);
  }
  contents.set('package.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n'));
  contents.set('README.md', await readFile(join(library.root, 'README.md')));
  const sourceFiles = [...files, ...declarations.map((file) => resolve(file.fileName))].sort();
  const sources = await Promise.all(sourceFiles.map(async (file) => ({
    name: relative(source, file).split(sep).join('/'), sha256: digest(await readFile(file)),
  })));
  contents.set('build.json', Buffer.from(JSON.stringify({
    name: library.name, version: library.version, distribution: 'local_tgz_unpublished',
    kind: 'development_library', sources,
    dependencies: versions,
    files: [...contents.entries()].map(([name, value]) => ({ name, bytes: value.length, sha256: digest(value) })),
  }, null, 2) + '\n'));
  // 源工程的开发条件和清单原样保留；归档使用上面派生的发行元数据。
  for (const [name, bytes] of contents) {
    if (name === 'package.json' || name === 'README.md') continue;
    const target = resolve(outputRoot, name);
    if (!within(outputRoot, target)) throw new Error('发行文件越界');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const chunks: Uint8Array[] = [];
  const entries = [...contents.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([name, body]) => ({
    header: { name: `package/${name}`, size: body.length, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) }, body,
  }));
  for await (const chunk of pack()(entries)) chunks.push(chunk);
  const bytes = gzipSync(Buffer.concat(chunks), { level: 9 });
  const archive = join(outputDirectory, `${library.name.replace(/^@/, '').replaceAll('/', '-')}-${library.version}.tgz`);
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, bytes);
  return {
    archive, name: library.name, version: library.version, bytes: bytes.length, sha256: digest(bytes),
    files: [...contents.keys()],
    declarations: Object.fromEntries(library.exports.map((entry) => [
      library.name + (entry.name === '.' ? '' : entry.name.slice(1)), resolve(outputRoot, entry.types),
    ])),
    typeFiles: program.getSourceFiles().filter((file) => file.isDeclarationFile &&
      !within(source, resolve(file.fileName)) && !file.fileName.includes('/typescript/lib/') &&
      !file.fileName.includes('\\typescript\\lib\\')).map((file) => resolve(file.fileName)),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = process.argv[2];
  if (!root) throw new Error('请指定独立库工程目录');
  const frontend = resolve(import.meta.dirname, '..');
  const result = await packageWorkspaceLibrary({ root, dependencies: {
    '@deviceforge/plugin-sdk': { version: '0.1.0', declarations: {
      '@deviceforge/plugin-sdk': join(frontend, 'sdk/lib/index.d.ts'),
    } },
    '@deviceforge/contracts': { version: '0.1.0', declarations: {
      '@deviceforge/contracts/api': join(frontend, 'contracts/api.d.ts'),
    } },
  } });
  console.log(JSON.stringify({ ...result, typeFiles: undefined, declarations: undefined,
    publication: '本地开发依赖包，未发布 registry，不是市场安装包' }, null, 2));
}
