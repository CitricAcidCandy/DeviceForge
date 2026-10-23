// 冻结当前宿主与网页为独立可审核npm产物，不覆盖工作区runtime。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { npmCommand } from '../../cli/src/processes.mjs';

const execute = promisify(execFile);
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function packNpx({ root, temporary, binaryDirectory }) {
  const staging = join(temporary, 'npm-source');
  await mkdir(join(staging, 'runtime', 'win32-x64'), { recursive: true });
  await cp(join(root, 'cli'), join(staging, 'cli'), { recursive: true });
  for (const file of ['package.json', 'README.md'])
    await copyFile(join(root, file), join(staging, file));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const file of ['apk-server.exe', 'validate-plugin.exe'])
    await copyFile(join(binaryDirectory, file), join(staging, 'runtime', 'win32-x64', file));
  await cp(join(root, 'frontend', 'dist'), join(staging, 'runtime', 'web'), { recursive: true });
  const binary = await readFile(join(binaryDirectory, 'apk-server.exe'));
  const validator = await readFile(join(binaryDirectory, 'validate-plugin.exe'));
  const manifest = {
    format_version: 1,
    version: pkg.version,
    profile: 'release',
    web: 'web',
    platforms: [
      {
        platform: 'win32',
        arch: 'x64',
        backend: 'win32-x64/apk-server.exe',
        validator: 'win32-x64/validate-plugin.exe',
        sha256: digest(binary),
        validator_sha256: digest(validator),
      },
    ],
  };
  await writeFile(
    join(staging, 'runtime', 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  const npm = npmCommand();
  const packed = await execute(
    npm.command,
    [...npm.prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
    { cwd: staging, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
  );
  const [entry] = JSON.parse(packed.stdout);
  assert.ok(entry.files.some((file) => file.path === 'runtime/manifest.json'));
  assert.ok(
    !entry.files.some((file) => file.path.startsWith('backend/') || file.path.startsWith('tools/')),
  );
  const archive = join(temporary, entry.filename),
    bytes = await readFile(archive);
  return {
    archive,
    sha256: digest(bytes),
    size: bytes.length,
    host_sha256: manifest.platforms[0].sha256,
    npx: join(dirname(npm.prefix[0]), 'npx-cli.js'),
  };
}
