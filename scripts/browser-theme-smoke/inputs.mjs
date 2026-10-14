import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export function themeArguments(values) {
  const result = { profile: 'debug', inProcessGpu: false };
  const seen = new Set();
  for (const value of values) {
    const key = value.startsWith('--frozen-input=') ? '--frozen-input' : value;
    assert.ok(['--release', '--in-process-gpu', '--frozen-input'].includes(key) && !seen.has(key), '主题验收参数无效或重复');
    seen.add(key);
    if (key === '--release') result.profile = 'release';
    if (key === '--in-process-gpu') result.inProcessGpu = true;
    if (key === '--frozen-input') {
      result.frozenDirectory = value.slice('--frozen-input='.length);
      assert.ok(result.frozenDirectory.length > 0, '冻结输入目录不能为空');
    }
  }
  return result;
}

// 冻结副本仍逐字复核，不把当前dist的热变内容混入本次身份。
export async function themeInputs(root, options) {
  const binaryName = process.platform === 'win32' ? 'apk-server.exe' : 'apk-server';
  if (!options.frozenDirectory) return {
    binary: resolve(root, 'backend/target', options.profile, binaryName),
    assetsDirectory: resolve(root, 'frontend/dist/assets'), extraPaths: [],
  };
  const directory = resolve(root, options.frozenDirectory), manifestPath = join(directory, 'identity.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.profile, options.profile, '冻结输入宿主模式须与命令一致');
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length >= 3 && manifest.entries.length <= 129, '冻结成员数无效');
  const members = new Set();
  for (const entry of manifest.entries) {
    const target = resolve(entry.target), member = relative(directory, target);
    assert.ok(member && !member.startsWith('..') && !isAbsolute(member) && !members.has(member), '冻结成员须唯一且位于冻结目录');
    members.add(member);
    const actual = await fileIdentity(target);
    assert.equal(actual.bytes, entry.bytes, '冻结成员大小改变');
    assert.equal(actual.sha256, entry.sha256, '冻结成员原字节改变');
  }
  assert.ok(members.has(binaryName) && members.has(join('assets', 'plugin-host.js')) && members.has(join('assets', 'browser-theme-harness.js')), '冻结输入缺少宿主或主题入口');
  const expectedAssets = [...members].filter(member => member.startsWith('assets')).map(member => relative('assets', member)).sort();
  const actualAssets = (await readdir(join(directory, 'assets'), { withFileTypes: true }))
    .filter(entry => entry.name.endsWith('.js')).map(entry => {
      assert.ok(entry.isFile() && !entry.isSymbolicLink(), '冻结ES模块须是普通文件'); return entry.name;
    }).sort();
  assert.deepEqual(actualAssets, expectedAssets, '冻结目录ES模块全集须与身份清单一致');
  return { binary: join(directory, binaryName), assetsDirectory: join(directory, 'assets'),
    extraPaths: [manifestPath, ...manifest.entries.map(entry => resolve(entry.target))], manifestPath };
}
