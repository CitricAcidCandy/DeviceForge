import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debuggerDigest, parseDebuggerFreeze, verifyDebuggerFreeze } from './debugger-fixture.ts';

/** 冻结只复制本次明确选择的成品，不构建、不安装、不替换运行服务。 */
export async function freezeDebugger(input: {
  host: string; frontend: string; official: string; destination: string;
}) {
  for (const path of Object.values(input)) assert.ok(isAbsolute(path), '冻结输入须使用绝对路径');
  const destination = resolve(input.destination);
  await mkdir(destination, { recursive: true });
  const host = join(destination, 'host/apk-server.exe');
  await mkdir(dirname(host), { recursive: true });
  await copyFile(input.host, host, constants.COPYFILE_EXCL);
  const scan = async (directory: string, include: (path: string) => boolean) => {
    const files: { path: string; sha256: string }[] = [];
    const walk = async (current: string) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), '冻结成品不接受符号链接');
        const path = join(current, entry.name);
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile()) continue;
        const name = relative(directory, path).replaceAll('\\', '/');
        if (include(name)) files.push({ path: name, sha256: debuggerDigest(await readFile(path)) });
      }
    };
    await walk(directory);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  };
  const frontend = resolve(input.frontend), source = resolve(input.official);
  const official = join(destination, 'official');
  const officialFiles = await scan(source, (path) =>
    ['package.json', 'plugin.json', 'market.json', 'README.md'].includes(path) || path.startsWith('dist/'));
  for (const file of officialFiles) {
    const target = join(official, file.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file.path), target, constants.COPYFILE_EXCL);
  }
  const value = {
    confirmed: true,
    frozen_at: new Date().toISOString(),
    scope: '本次构建成品；验收结果另存，不表示首期全部通过',
    host: { path: host, sha256: debuggerDigest(await readFile(host)) },
    frontend: { directory: frontend, files: await scan(frontend, (path) => !path.endsWith('.map')) },
    official: { directory: official, files: officialFiles },
  };
  await verifyDebuggerFreeze(parseDebuggerFreeze(value));
  const path = join(destination, 'freeze.json');
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return { path, host_sha256: value.host.sha256, frontend_files: value.frontend.files.length,
    official_files: value.official.files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, frontend, official, destination, ...extra] = process.argv.slice(2);
  assert.ok(host && frontend && official && destination && extra.length === 0,
    '用法：node scripts/freeze-debugger.ts <绝对宿主exe> <绝对前端目录> <绝对插件目录> <新的绝对冻结目录>');
  console.log(JSON.stringify(await freezeDebugger({ host, frontend, official, destination }), null, 2));
}
