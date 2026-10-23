// 固定官方来源并校验下载字节；不会安装、执行工具或读取部署者认证。
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { RESOURCE_LIMIT } from './contract.mjs';

export const officialToolDownloads = [
  {
    id: 'node', version: '24.14.0', filename: 'node-v24.14.0-win-x64.zip', format: 'zip',
    url: 'https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip',
    sha256: '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66',
  },
  {
    id: 'codex-sdk', version: '0.162.1', filename: 'codex-sdk-0.162.1.tgz', format: 'tgz',
    url: 'https://registry.npmjs.org/@openai/codex-sdk/-/codex-sdk-0.162.1.tgz',
    integrity: 'sha512-oG3u4y8Zq9t5QvlABcGo0cby/E2d6nrYZq71F/JBy2VOsOoqhhaMlbA7/35SWsykYGouL+T+3RgRT2X/xE+Y1g==',
  },
  {
    id: 'codex-cli', version: '0.162.1', filename: 'codex-0.162.1-win32-x64.tgz', format: 'tgz',
    url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.162.1-win32-x64.tgz',
    integrity: 'sha512-dfl4MhHuEi0ARKyNmrTxk+RQmsWNCQAoVLUtrYq+yrW1C8P2sg5ziwgHUUACHjYLKuACV7ARH5Nq5pnCz3GlaQ==',
  },
];

async function inspect(path, declaration) {
  const digest = createHash('sha256'), integrity = createHash('sha512');
  const information = await stat(path);
  if (!information.isFile() || information.size <= 0 || information.size > RESOURCE_LIMIT)
    throw new Error('官方工具文件大小或类型无效');
  for await (const chunk of createReadStream(path)) { digest.update(chunk); integrity.update(chunk); }
  const sha256 = digest.digest('hex'), sri = `sha512-${integrity.digest('base64')}`;
  if ((declaration.sha256 && declaration.sha256 !== sha256) ||
      (declaration.integrity && declaration.integrity !== sri))
    throw new Error(`官方工具摘要不匹配：${declaration.id}`);
  return { ...declaration, file: path, size: information.size, sha256, integrity: sri };
}

export async function fetchOfficialTool(directory, declaration) {
  const destination = join(directory, declaration.filename);
  try { return await inspect(destination, declaration); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(declaration.url, { signal: AbortSignal.timeout(900000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`官方工具下载失败：${declaration.id} HTTP ${response.status}`);
  let size = 0;
  const bound = new Transform({ transform(chunk, encoding, done) {
    size += chunk.length;
    done(size <= RESOURCE_LIMIT ? null : new Error('官方工具下载超过2GiB'), chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(destination, { flags: 'wx' }));
  return inspect(destination, declaration);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] || 'artifacts/plugin-release-candidates-20261022/official-tools');
  await mkdir(directory, { recursive: true });
  const results = await Promise.allSettled(officialToolDownloads.map((item) => fetchOfficialTool(directory, item)));
  const report = results.map((result, index) => result.status === 'fulfilled'
    ? { status: 'download_verified', ...result.value }
    : { status: 'failed', id: officialToolDownloads[index].id, message: result.reason.message });
  const path = join(directory, `download-report-${Date.now()}.json`);
  await writeFile(path, JSON.stringify({ created_at: new Date().toISOString(), report }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report_path: path, report }, null, 2));
  if (report.some((item) => item.status === 'failed')) process.exitCode = 1;
}
