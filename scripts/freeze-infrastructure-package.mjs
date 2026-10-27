import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, readJson, regularFile } from '../cli/src/paths.mjs';
import { loadRuntime, sha256 } from '../cli/src/runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const overrideKey = 'DEVICEFORGE_CLI_SMOKE_PACKAGE_ROOT';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fingerprint = (files) => digest(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));

function absoluteDirectoryPath(value) {
  if (
    typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value) ||
    (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value))
  ) throw new Error('包目录必须是完整绝对路径');
  return resolve(value);
}

async function plainDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('包目录必须为非链接普通目录');
}

export async function selectSmokePackageRoot(sourceRoot, environment = process.env) {
  const selected = environment[overrideKey];
  if (selected === undefined) return sourceRoot;
  const candidate = absoluteDirectoryPath(selected);
  await plainDirectory(candidate);
  const expected = await readJson(join(sourceRoot, 'package.json'));
  const actual = await readJson(join(candidate, 'package.json'));
  if (typeof expected.name !== 'string' || !expected.name || typeof expected.version !== 'string' || !expected.version) {
    throw new Error('原源码根缺少有效的 package.name/version');
  }
  if (actual.name !== expected.name || actual.version !== expected.version) {
    throw new Error('验收包的 package.name/version 必须与原源码根一致');
  }
  return realpath(candidate);
}

async function inventoryInputs(sourceRoot) {
  const files = [];
  const add = async (source, path) => {
    const absolute = await regularFile(sourceRoot, source);
    const info = await lstat(absolute);
    files.push({ source, path, bytes: info.size, sha256: await sha256(absolute), source_mtime: info.mtime.toISOString() });
  };
  const tree = async (source, destination) => {
    const directory = join(sourceRoot, source);
    await plainDirectory(directory);
    assert.ok(inside(await realpath(sourceRoot), await realpath(directory)), '输入目录不得越出源码根');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('冻结输入不能包含符号链接或目录联接');
      const next = `${source}/${entry.name}`;
      const target = `${destination}/${entry.name}`;
      if (entry.isDirectory()) await tree(next, target);
      else if (entry.isFile()) await add(next, target);
      else throw new Error('冻结输入只能包含普通文件和目录');
    }
  };
  await tree('cli', 'cli');
  for (const path of ['README.md', 'package.json', 'scripts/verify-package.mjs']) await add(path, path);
  const platform = `${process.platform}-${process.arch}`;
  for (const name of ['apk-server.exe', 'validate-plugin.exe']) {
    await add(`backend/target/release/${name}`, `runtime/${platform}/${name}`);
  }
  await tree('frontend/dist', 'runtime/web');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function copyInputs(sourceRoot, packRoot, files, copy) {
  for (const file of files) {
    const destination = join(packRoot, file.path);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await copy(join(sourceRoot, file.source), destination);
    assert.equal((await lstat(destination)).size, file.bytes, `冻结副本长度变化：${file.path}`);
    assert.equal(await sha256(destination), file.sha256, `冻结副本摘要变化：${file.path}`);
  }
}

function runtimeManifest(version, files) {
  const platform = `${process.platform}-${process.arch}`;
  const backend = `runtime/${platform}/apk-server.exe`;
  const validator = `runtime/${platform}/validate-plugin.exe`;
  return {
    format_version: 1,
    version,
    profile: 'release',
    capabilities: ['plugin_dependencies_v1'],
    web: 'web',
    platforms: [{
      platform: process.platform,
      arch: process.arch,
      backend: backend.slice('runtime/'.length),
      validator: validator.slice('runtime/'.length),
      sha256: files.find((file) => file.path === backend).sha256,
      validator_sha256: files.find((file) => file.path === validator).sha256,
    }],
  };
}

export async function freezeInfrastructurePackage(sourceRoot = root, { copy = copyFile } = {}) {
  if (process.platform !== 'win32') throw new Error('此冻结入口仅接收当前 Windows release EXE，不构建其他平台');
  sourceRoot = absoluteDirectoryPath(sourceRoot);
  await plainDirectory(sourceRoot);
  const before = await inventoryInputs(sourceRoot);
  const artifacts = join(sourceRoot, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await plainDirectory(artifacts);
  assert.ok(inside(await realpath(sourceRoot), await realpath(artifacts)), 'stage 目录不得越出源码根');
  const stage = await mkdtemp(join(artifacts, `infrastructure-package-${Date.now()}-`));
  const packRoot = join(stage, 'package');
  const reportPath = join(stage, 'freeze-report.json');
  const report = {
    format_version: 1,
    timestamp: new Date().toISOString(),
    sourceRoot,
    packRoot,
    passed: false,
    scope: '仅复制当前 CLI、release EXE 与前端 dist 并核对字节；不构建、不打包、不修改根 runtime，不证明新源码构建或服务验收',
    source_fingerprint: fingerprint(before),
    sources: before,
  };
  try {
    await mkdir(packRoot);
    await copyInputs(sourceRoot, packRoot, before, copy);
    const pkg = await readJson(join(packRoot, 'package.json'));
    assert.equal(pkg.name, '@deviceforge/cli', '冻结输入不是 DeviceForge CLI 包');
    assert.ok(typeof pkg.version === 'string' && pkg.version, '冻结包版本缺失');
    const manifest = runtimeManifest(pkg.version, before);
    const manifestPath = join(packRoot, 'runtime/manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    // 不运行 npm 生命周期；直接使用同一运行包加载规则验证副本。
    const runtime = await loadRuntime(packRoot);
    assert.equal(runtime.version, pkg.version, '冻结运行包版本不一致');
    assert.equal(runtime.dependencyPreparation, true, '冻结运行包缺少 plugin_dependencies_v1 能力');
    const host = await readFile(join(runtime.web, 'assets/plugin-host.js'), 'utf8');
    assert.ok(host.includes('createFrontendRuntime') && host.includes('createNamedSlotAdapter'), '冻结前端缺少公开浏览器宿主入口');
    assert.equal(await selectSmokePackageRoot(sourceRoot, { [overrideKey]: packRoot }), await realpath(packRoot));
    const after = await inventoryInputs(sourceRoot);
    report.source_fingerprint_after = fingerprint(after);
    assert.equal(report.source_fingerprint_after, report.source_fingerprint, '冻结期间源码或构建产物漂移，拒绝交付混合字节');
    report.files = [
      ...before.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      { path: 'runtime/manifest.json', bytes: (await lstat(manifestPath)).size, sha256: await sha256(manifestPath) },
    ].sort((a, b) => a.path.localeCompare(b.path));
    report.package_fingerprint = fingerprint(report.files);
    report.package = { name: pkg.name, version: pkg.version };
    report.passed = true;
    report.completed_at = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { packRoot, reportPath, report };
  } catch (error) {
    report.passed = false;
    report.error = { name: error.name, message: String(error.message).slice(0, 1500) };
    report.completed_at = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }).catch(() => {});
    error.message = `冻结失败，保留本次 stage：${stage}；${error.message}`;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('冻结脚本不接受构建或输出目录参数');
    const { packRoot, reportPath, report } = await freezeInfrastructurePackage();
    console.log(JSON.stringify({ packRoot, reportPath, source_fingerprint: report.source_fingerprint, package_fingerprint: report.package_fingerprint, files: report.files.length }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
