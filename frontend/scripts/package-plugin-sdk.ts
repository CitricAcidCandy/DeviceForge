import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { pack } from 'it-tar';
import ts from 'typescript';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = join(frontend, 'src/plugin-sdk');
const sdkTemplate = join(frontend, 'sdk');
export interface SdkPackageOptions { readonly outputRoot?: string }
export interface SdkPackageResult {
  readonly archive: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: readonly string[];
  /** 仅供本地消费验证复制公开第三方声明，不作为包内宿主依赖。 */
  readonly typeFiles: readonly string[];
}
function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function diagnostic(errors: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => frontend,
    getNewLine: () => '\n',
  });
}

/** 只编译公开 SDK，生成可直接安装的本地包；不运行全前端构建和网络安装。 */
export async function packagePluginSdk(options: SdkPackageOptions = {}): Promise<SdkPackageResult> {
  const outputRoot = resolve(options.outputRoot ?? sdkTemplate);
  if (within(sourceRoot, outputRoot)) throw new Error('SDK 产物不能覆盖公开契约源码');
  const lib = join(outputRoot, 'lib');
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) throw new Error('SDK 源码不能通过符号链接引入私有实现');
  const inputs = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
    .map((entry) => join(sourceRoot, entry.name));
  const required = ['index.ts', 'json.ts', 'points.ts', 'workspace.ts', 'transport.ts', 'data-sources.ts'];
  if (required.some((name) => !inputs.includes(join(sourceRoot, name)))) throw new Error('SDK 公开契约尚未完整');
  const program = ts.createProgram(inputs, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    declaration: true, declarationMap: false, sourceMap: false, outDir: lib, rootDir: sourceRoot,
    rewriteRelativeImportExtensions: true, allowImportingTsExtensions: true, skipLibCheck: true,
    types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) throw new Error(diagnostic(errors));
  const output = new Map<string, string>();
  const emitted = program.emit(undefined, (file, text) => {
    if (!within(lib, resolve(file))) throw new Error('SDK 编译产物越过自身 lib 目录');
    // 声明中的源码扩展名也改为包内 ESM 路径，NodeNext 消费方无需允许导入 .ts。
    output.set(resolve(file), file.endsWith('.d.ts')
      ? text.replace(/(['"])(\.{1,2}\/[^'"]+)\.ts\1/g, '$1$2.js$1') : text);
  });
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error(diagnostic(emitted.diagnostics));
  const packages = new Map<string, Uint8Array>();
  for (const [file, text] of output) packages.set(relative(outputRoot, file).split(sep).join('/'), Buffer.from(text));
  const metadata = await readFile(join(sdkTemplate, 'package.json'));
  const info: unknown = JSON.parse(metadata.toString('utf8'));
  if (!info || typeof info !== 'object' || !('name' in info) || info.name !== '@deviceforge/plugin-sdk' ||
      !('version' in info) || info.version !== '0.1.0' || !('private' in info) || info.private !== true)
    throw new Error('本地 SDK 发行身份无效，禁止隐式改成 registry 发布');
  packages.set('package.json', metadata);
  packages.set('README.md', await readFile(join(sdkTemplate, 'README.md')));
  const sources = await Promise.all(inputs.map(async (file) => ({ name: relative(sourceRoot, file), sha256: digest(await readFile(file)) })));
  const build = {
    name: '@deviceforge/plugin-sdk', version: '0.1.0', frontend_sdk_version: 2,
    distribution: 'local_tgz_unpublished', sources,
    files: [...packages.entries()].map(([name, bytes]) => ({ name, size: bytes.length, sha256: digest(bytes) })),
  };
  packages.set('build.json', Buffer.from(JSON.stringify(build, null, 2) + '\n'));
  await mkdir(lib, { recursive: true });
  // 只删 lib 内旧生成文件，绝不递归删除任意计算目录或修改宿主源码。
  for (const entry of await readdir(lib, { withFileTypes: true })) {
    const path = resolve(lib, entry.name);
    if (entry.isFile() && /\.(?:js|d\.ts)$/.test(entry.name) && !output.has(path)) {
      if (!within(lib, path)) throw new Error('旧 SDK 产物清理目标越界');
      await rm(path);
    }
  }
  for (const [name, bytes] of packages) {
    const target = join(outputRoot, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const chunks: Uint8Array[] = [];
  const candidates = [...packages.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([name, body]) => ({
    header: { name: `package/${name}`, size: body.length, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) }, body,
  }));
  for await (const chunk of pack()(candidates)) chunks.push(chunk);
  const bytes = gzipSync(Buffer.concat(chunks), { level: 9 });
  const archive = join(outputRoot, 'dist/deviceforge-plugin-sdk-0.1.0.tgz');
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, bytes);
  const dependencies = join(frontend, 'node_modules');
  const typeFiles = program.getSourceFiles().map((file) => resolve(file.fileName))
    .filter((file) => within(dependencies, file) && !within(join(dependencies, 'typescript'), file));
  return { archive, sha256: digest(bytes), bytes: bytes.length, files: [...packages.keys()], typeFiles };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await packagePluginSdk();
  console.log(JSON.stringify({ archive: result.archive, sha256: result.sha256, bytes: result.bytes, files: result.files.length,
    publication: '本地包，未发布 registry' }, null, 2));
}
