import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { archiveInstalledSdkPackage } from './installed-sdk-package.ts';

export interface SdkPackageOptions { readonly outputRoot?: string }
export interface SdkPackageResult {
  readonly archive: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: readonly string[];
  readonly typeFiles: readonly string[];
  readonly dependencyRoot: string;
}
/** 重封已安装SDK发行文件，不运行外部源码构建器，也不改动运行与声明字节。 */
export async function packagePluginSdk(options: SdkPackageOptions = {}): Promise<SdkPackageResult> {
  const frontend = resolve(import.meta.dirname, '..');
  const result = await archiveInstalledSdkPackage(frontend, 'sdk', options.outputRoot ?? join(frontend, 'artifacts/installed-sdk'));
  const dependencyRoot = join(frontend, 'node_modules');
  const program = ts.createProgram([join(result.sourceRoot, 'lib/index.d.ts')], {
    noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
    types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  });
  const typeFiles = program.getSourceFiles().filter((file) => file.isDeclarationFile &&
    !program.isSourceFileDefaultLibrary(file) && !resolve(file.fileName).startsWith(result.sourceRoot + sep))
    .map((file) => resolve(file.fileName));
  for (const file of typeFiles) {
    const part = relative(dependencyRoot, file);
    if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
      throw new Error('SDK声明依赖必须来自前端已安装公开包');
  }
  return { archive: result.archive, sha256: result.sha256, bytes: result.bytes, files: result.files, typeFiles, dependencyRoot };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await packagePluginSdk();
  console.log(JSON.stringify({ archive: result.archive, sha256: result.sha256, bytes: result.bytes,
    files: result.files.length, publication: '已安装公开SDK发行文件重新归档，未重编；摘要仅代表本次归档' }, null, 2));
}
