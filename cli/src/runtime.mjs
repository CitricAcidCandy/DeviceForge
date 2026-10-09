import { readJson, regularFile, packagePath } from './paths.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export async function loadRuntime(packageRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  const root = join(packageRoot, 'runtime');
  const manifest = await readJson(join(root, 'manifest.json'));
  if (manifest.format_version !== 1 || !Array.isArray(manifest.platforms)) throw new Error('运行包清单版本或平台列表无效');
  const entry = manifest.platforms.find((item) => item.platform === process.platform && item.arch === process.arch);
  if (!entry) throw new Error(`此运行包尚未包含 ${process.platform}/${process.arch}，请构建对应平台包`);
  const binary = await regularFile(root, entry.backend);
  if (await sha256(binary) !== entry.sha256) throw new Error('后端运行包摘要不匹配');
  const validator = await regularFile(root, entry.validator);
  if (await sha256(validator) !== entry.validator_sha256) throw new Error('插件校验程序摘要不匹配');
  const web = packagePath(root, manifest.web);
  if (!(await lstat(web)).isDirectory()) throw new Error('前端运行资源缺失');
  await regularFile(web, 'index.html');
  return { binary, validator, web: await realpath(web), version: manifest.version };
}
