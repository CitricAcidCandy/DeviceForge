// 从一份开发清单生成组件、市场资料和完整发布，不修改源工程。
import { mkdir, mkdtemp, realpath, rename, rm, writeFile, copyFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inside, readJson, regularFile, packagePath } from '../paths.mjs';
import { writeTgz, writeZip } from '../../../scripts/plugin-releases/archive.mjs';
import { validateRelease, releaseResources } from '../../../scripts/plugin-releases/contract.mjs';
import { prepareDependencies } from '../../../scripts/plugin-releases/pack-dependencies.mjs';
import { measureFile, verifyFile } from '../../../scripts/plugin-releases/io.mjs';
import { jsonBytes, digestBytes, verifyReleaseDirectory } from '../../../scripts/plugin-releases/pack.mjs';
import { normalizeManifest } from './manifest.mjs';
import { componentMembers } from './components.mjs';
import { marketMetadata } from './market.mjs';

export async function packPlugin({ source = 'manifest.json', destination, platform = `${process.platform}-${process.arch}` }, { signal } = {}) {
  if (!/^[a-z0-9]+-[a-z0-9-]+$/.test(platform)) throw new Error('打包平台必须为 os-arch 标识');
  const manifestPath = resolve(source), base = dirname(manifestPath);
  const declaration = normalizeManifest(await readJson(manifestPath, 1024 * 1024));
  const target = resolve(destination ?? join(base, 'dist-plugin'));
  // 既有输出不覆盖，失败只回收本次独占暂存。
  try { await realpath(target); throw new Error('输出目录已存在，请使用新目录'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = await realpath(dirname(target));
  for (const component of declaration.components) for (const path of component.files) {
    const root = component.root === '.' ? base : packagePath(base, component.root);
    const input = packagePath(root, path);
    if ((await lstat(input)).isDirectory() && inside(await realpath(input), parent))
      throw new Error('输出目录不能位于 files 选择的构建产物目录内');
  }
  const staging = await mkdtemp(join(parent, '.deviceforge-pack-'));
  try {
    signal?.throwIfAborted();
    const files = new Map();
    for (const values of Object.values(declaration.dependency_files)) {
      for (const input of Array.isArray(values) ? values : [values]) await regularFile(base, input.file);
    }
    const dependencies = await prepareDependencies(declaration.release.dependencies, declaration.dependency_files, base, files);
    const components = [];
    await mkdir(join(staging, 'components'));
    await mkdir(join(staging, 'blobs'));
    for (const component of declaration.components) {
      signal?.throwIfAborted();
      const entry = component.entrypoints[platform] ?? component.entrypoints.any;
      if (!entry) throw new Error(`组件 ${component.id} 不支持平台 ${platform}`);
      const members = await componentMembers(base, declaration, component, dependencies, signal);
      const file = join(staging, 'components', `${component.id}.tgz`);
      await writeTgz(file, members);
      const measured = await measureFile(file);
      files.set(measured.sha256, file);
      components.push({ id: component.id, kind: component.kind, version: component.version,
        variants: [{ platform: entry.runtime === 'browser' ? 'any' : platform, format: 'tgz',
          path: `blobs/${measured.sha256}`, ...measured }] });
    }
    const manifest = validateRelease({ ...declaration.release, components, dependencies });
    const resources = releaseResources(manifest);
    for (const resource of resources) {
      signal?.throwIfAborted();
      const file = files.get(resource.sha256);
      if (!file) throw new Error(`发布缺少本地资源：${resource.sha256}`);
      await verifyFile(file, resource);
      const output = join(staging, resource.path);
      try { await copyFile(file, output, 1); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const market = marketMetadata(declaration);
    const manifestBytes = jsonBytes(manifest);
    await writeFile(join(staging, 'release.json'), manifestBytes, { flag: 'wx' });
    await writeFile(join(staging, 'market.json'), jsonBytes(market), { flag: 'wx' });
    await verifyReleaseDirectory(staging);
    const archiveName = `${manifest.id}-${manifest.version}-${platform}.zip`;
    const archive = join(staging, archiveName);
    const unique = new Map(resources.map((resource) => [resource.path, { name: resource.path, path: join(staging, resource.path) }]));
    await writeZip(archive, [{ name: 'release.json', bytes: manifestBytes },
      { name: 'market.json', bytes: jsonBytes(market) }, ...unique.values()]);
    const report = { id: manifest.id, version: manifest.version, platform, revision: digestBytes(manifestBytes),
      components: components.length, resources: unique.size, archive: join(target, archiveName),
      ...(await measureFile(archive)) };
    await writeFile(join(staging, 'pack-report.json'), jsonBytes(report), { flag: 'wx' });
    signal?.throwIfAborted();
    await rename(staging, target);
    return report;
  } finally {
    // 暂存身份与父目录同时核对；已发布目录不属于清理目标。
    try {
      const checked = await realpath(staging);
      if (!inside(parent, checked) || checked === parent) throw new Error('打包暂存清理路径越界');
      await rm(checked, { recursive: true, force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
