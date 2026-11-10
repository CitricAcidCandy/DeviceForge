import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkBrowserPackage } from './sdk-repository.ts';

/** 只读核对公开发行类型；宿主生成器不再覆盖SDK仓库或已安装包。 */
export async function syncPluginContracts(frontendRoot: string): Promise<void> {
  const source = resolve(frontendRoot, 'src/services/api/generated.ts');
  const target = resolve(sdkBrowserPackage(frontendRoot, 'contracts'), 'api.d.ts');
  const existing = await readFile(target).catch(() => null);
  const current = await readFile(source);
  if (existing?.equals(current)) return;
  throw new Error('已安装的公开 HTTP 声明与宿主生成结果不一致；请在 SDK 仓库更新并发行契约包，再更新宿主依赖');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await syncPluginContracts(fileURLToPath(new URL('..', import.meta.url)));
