import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sdkBrowserPackage } from './sdk-repository.ts';

export interface SdkPackageOptions { readonly outputRoot?: string }
export interface SdkPackageResult {
  readonly archive: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: readonly string[];
  readonly typeFiles: readonly string[];
  readonly dependencyRoot: string;
}
interface SdkPackager {
  packagePluginSdk(options?: SdkPackageOptions): Promise<SdkPackageResult>;
}

/** 保留宿主维护命令兼容；打包实现和源码只存在于独立SDK仓库。 */
export async function packagePluginSdk(options: SdkPackageOptions = {}): Promise<SdkPackageResult> {
  const frontend = resolve(import.meta.dirname, '..');
  const entry = pathToFileURL(resolve(sdkBrowserPackage(frontend, 'sdk'), 'scripts/package.ts')).href;
  const module: SdkPackager = await import(entry);
  return module.packagePluginSdk(options);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await packagePluginSdk();
  console.log(JSON.stringify({ archive: result.archive, sha256: result.sha256, bytes: result.bytes,
    files: result.files.length, publication: '独立SDK仓库本地包，未发布registry' }, null, 2));
}
