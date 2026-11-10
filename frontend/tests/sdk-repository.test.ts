import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import test from 'node:test';
import { HostError as compatibilityError } from '../src/plugin-sdk/index.ts';
import { HostError as packageError } from '@deviceforge/plugin-sdk';
import { sdkBrowserPackage } from '../scripts/sdk-repository.ts';
import { syncPluginContracts } from '../scripts/sync-plugin-contracts.ts';
import { archiveInstalledSdkPackage } from '../scripts/installed-sdk-package.ts';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';

const frontend = resolve(import.meta.dirname, '..');

test('宿主只保留SDK薄兼容入口，与独立包共享同一错误类型', () => {
  assert.equal(compatibilityError, packageError);
  assert.equal(existsSync(resolve(frontend, 'sdk')), false);
  assert.equal(existsSync(resolve(frontend, 'plugin-tools')), false);
  assert.equal(existsSync(resolve(frontend, 'contracts')), false);
  const entry = readFileSync(resolve(frontend, 'src/plugin-sdk/index.ts'), 'utf8');
  assert.match(entry, /export \* from '@deviceforge\/plugin-sdk'/);
  assert.doesNotMatch(entry, /class HostError|interface HostContext/);
  for (const name of ['sdk', 'tools', 'contracts'] as const)
    assert.ok(existsSync(resolve(sdkBrowserPackage(frontend, name), 'package.json')));
});

test('SDK只从已安装公开包定位，不读取隐式环境变量或同级源码', async () => {
  const parent = join(frontend, 'artifacts');
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(join(parent, 'installed-sdk-'));
  const original = process.env['DEVICEFORGE_SDK_ROOT'];
  try {
    process.env['DEVICEFORGE_SDK_ROOT'] = '不会读取的旧环境变量';
    const installed = join(fixture, 'node_modules/@deviceforge/plugin-sdk');
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@deviceforge/plugin-sdk', version: '0.1.0' }));
    assert.equal(sdkBrowserPackage(fixture, 'sdk'), installed);
    assert.throws(() => sdkBrowserPackage(fixture, 'tools'), /已安装.*plugin-tools|npm install/);
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '错误包', version: '0.1.0' }));
    assert.throws(() => sdkBrowserPackage(fixture, 'sdk'), /身份/);
  } finally {
    if (original === undefined) delete process.env['DEVICEFORGE_SDK_ROOT'];
    else process.env['DEVICEFORGE_SDK_ROOT'] = original;
    assert.ok(resolve(fixture).startsWith(resolve(parent) + sep));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('契约同步只核对已安装声明，差异不覆盖公开发行文件', async () => {
  const parent = join(frontend, 'artifacts');
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(join(parent, 'installed-contracts-'));
  try {
    const installed = join(fixture, 'node_modules/@deviceforge/contracts');
    await mkdir(installed, { recursive: true });
    await mkdir(join(fixture, 'src/services/api'), { recursive: true });
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@deviceforge/contracts', version: '0.1.0' }));
    const target = join(installed, 'api.d.ts');
    await writeFile(target, 'export type Original = 1;');
    await writeFile(join(fixture, 'src/services/api/generated.ts'), 'export type Updated = 2;');
    await assert.rejects(syncPluginContracts(fixture), /已安装.*声明.*不一致|SDK.*发行/);
    assert.equal(await readFile(target, 'utf8'), 'export type Original = 1;');
    await writeFile(join(fixture, 'src/services/api/generated.ts'), 'export type Original = 1;');
    await syncPluginContracts(fixture);
  } finally {
    assert.ok(resolve(fixture).startsWith(resolve(parent) + sep));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('重新归档只读取已安装包发行清单，保留运行和声明原字节且不执行源码构建', async () => {
  const parent = join(frontend, 'artifacts');
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(join(parent, 'installed-sdk-archive-'));
  try {
    const installed = join(fixture, 'node_modules/@deviceforge/plugin-tools');
    await mkdir(join(installed, 'lib'), { recursive: true });
    await mkdir(join(installed, 'scripts'), { recursive: true });
    const metadata = JSON.stringify({ name: '@deviceforge/plugin-tools', version: '1.2.3', files: ['lib', 'README.md'] });
    await writeFile(join(installed, 'package.json'), metadata);
    await writeFile(join(installed, 'README.md'), '已发行工具');
    await writeFile(join(installed, 'lib/index.js'), 'export const value = "运行原字节";\r\n');
    await writeFile(join(installed, 'lib/index.d.ts'), 'export declare const value: string;\r\n');
    await writeFile(join(installed, 'scripts/package.ts'), 'throw new Error("不能执行源码构建");');
    const result = await archiveInstalledSdkPackage(fixture, 'tools', join(fixture, 'output'));
    assert.equal(result.source, 'installed_package_rearchive');
    assert.equal(result.version, '1.2.3');
    assert.deepEqual(result.files, ['lib/index.d.ts', 'lib/index.js', 'package.json', 'README.md']);
    for await (const entry of extract()([gunzipSync(await readFile(result.archive))])) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of entry.body) chunks.push(chunk.subarray());
      assert.deepEqual(Buffer.concat(chunks), await readFile(join(installed, entry.header.name.slice(8))));
    }
    await assert.rejects(archiveInstalledSdkPackage(fixture, 'tools', join(installed, 'dist')), /不得写入/);
    assert.equal(await readFile(join(installed, 'package.json'), 'utf8'), metadata);
  } finally {
    assert.ok(resolve(fixture).startsWith(resolve(parent) + sep));
    await rm(fixture, { recursive: true, force: true });
  }
});
