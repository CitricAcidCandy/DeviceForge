import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../cli/src/runtime.mjs';
import { npmCommand } from '../cli/src/processes.mjs';
import { inside, readJson, atomicRename } from '../cli/src/paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'artifacts'), { recursive: true });
// 正式分发默认 release；--debug 用于本地流程验收，不冒充发布构建。
if (process.argv.slice(2).some((value) => value !== '--debug'))
  throw new Error('只支持可选 --debug');
const debug = process.argv.includes('--debug');
const profile = debug ? 'debug' : 'release';
const cargoArgs = [
  'build',
  '--locked',
  '-p',
  'apk-server',
  '--bins',
  ...(debug ? [] : ['--release']),
];
execFileSync('cargo', cargoArgs, {
  cwd: join(root, 'backend'),
  stdio: 'inherit',
  windowsHide: true,
});
const npm = npmCommand();
execFileSync(npm.command, [...npm.prefix, 'ci'], {
  cwd: join(root, 'frontend'),
  stdio: 'inherit',
  windowsHide: true,
});
execFileSync(npm.command, [...npm.prefix, 'run', 'build'], {
  cwd: join(root, 'frontend'),
  stdio: 'inherit',
  windowsHide: true,
});
const stagingRoot = join(root, '.runtime-staging');
await mkdir(stagingRoot, { recursive: true });
const temporary = await mkdtemp(join(stagingRoot, 'build-'));
const destination = join(root, 'runtime');
let backup;
try {
  const platform = `${process.platform}-${process.arch}`;
  const bin = join(temporary, platform);
  await mkdir(bin);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const backend = `${platform}/apk-server${suffix}`;
  const validator = `${platform}/validate-plugin${suffix}`;
  await copyFile(
    join(root, 'backend/target', profile, `apk-server${suffix}`),
    join(temporary, backend),
  );
  await copyFile(
    join(root, 'backend/target', profile, `validate-plugin${suffix}`),
    join(temporary, validator),
  );
  await cp(join(root, 'frontend/dist'), join(temporary, 'web'), {
    recursive: true,
    dereference: false,
  });
  const pkg = await readJson(join(root, 'package.json'));
  await writeFile(
    join(temporary, 'manifest.json'),
    JSON.stringify(
      {
        format_version: 1,
        version: pkg.version,
        profile,
        capabilities: ['plugin_dependencies_v1'],
        web: 'web',
        platforms: [
          {
            platform: process.platform,
            arch: process.arch,
            backend,
            validator,
            sha256: await sha256(join(temporary, backend)),
            validator_sha256: await sha256(join(temporary, validator)),
          },
        ],
      },
      null,
      2,
    ),
  );
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('运行包目录不是普通目录');
    backup = join(stagingRoot, `backup-${Date.now()}`);
    await rename(destination, backup);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await atomicRename(temporary, destination);
  } catch (error) {
    if (backup) {
      await rename(backup, destination);
      backup = undefined;
    }
    throw error;
  }
  console.log(`运行包已生成：${platform}，${profile}，包含后端、离线插件校验器和前端资源`);
} finally {
  // 仅删除本脚本创建的 staging/backup 目录，目标路径必须在工程 staging 内。
  for (const path of [temporary, backup].filter(Boolean)) {
    if (!inside(stagingRoot, path) || path === stagingRoot) throw new Error('构建清理路径越界');
    await rm(path, { recursive: true, force: true });
  }
}
