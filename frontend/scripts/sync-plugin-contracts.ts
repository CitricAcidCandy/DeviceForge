import { copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 发行类型逐字节复用现有生成结果，不手抄第二份 HTTP DTO。 */
export async function syncPluginContracts(frontendRoot: string): Promise<void> {
  const source = resolve(frontendRoot, 'src/services/api/generated.ts');
  const target = resolve(frontendRoot, 'contracts/api.d.ts');
  const existing = await readFile(target).catch(() => null);
  const current = await readFile(source);
  if (existing?.equals(current)) return;
  await copyFile(source, target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await syncPluginContracts(fileURLToPath(new URL('..', import.meta.url)));
