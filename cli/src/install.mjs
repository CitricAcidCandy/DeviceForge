import { mkdir, mkdtemp, rm, rmdir, writeFile, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  materializeManifest,
  readMarketMetadata,
  validateRegistrySource,
} from './plugin-package.mjs';
import { copyPackage } from './plugin-files.mjs';
import { readJson, inside, atomicRename } from './paths.mjs';
import { loadRuntime } from './runtime.mjs';
import { runNpm } from './processes.mjs';

async function sourceDirectory(source, temporary, signal) {
  const local = resolve(source);
  let info;
  try {
    info = await lstat(local);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (info?.isDirectory()) {
    if (info.isSymbolicLink()) throw new Error('插件源目录不得为链接');
    return local;
  }
  const specification =
    info?.isFile() && source.endsWith('.tgz') ? local : validateRegistrySource(source);
  const download = join(temporary, 'npm');
  await mkdir(download);
  await writeFile(
    join(download, 'package.json'),
    JSON.stringify({ private: true, name: 'deviceforge-plugin-staging', version: '0.0.0' }),
  );
  // 不运行包脚本；可移植服务器插件应自带原生入口或纯 Node.js 入口。
  const environment = { ...process.env };
  delete environment.APK_API_TOKEN;
  await runNpm(
    [
      'install',
      '--prefix',
      download,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '--',
      specification,
    ],
    { env: environment, signal },
  );
  const pkg = await readJson(join(download, 'package.json'));
  const dependencies = Object.keys(pkg.dependencies || {});
  if (dependencies.length !== 1) throw new Error('一次安装只能包含一个插件根包');
  const name = dependencies[0];
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new Error('npm 插件包名无效');
  const root = join(download, 'node_modules', ...name.split('/'));
  // 保留 npm 已安装的依赖树，入口在根包内；发布目录属于独立调用，不共享 npm 缓存路径。
  return { root, modules: join(download, 'node_modules'), name };
}

export async function installPlugin(options, { signal, runtime, environment = process.env } = {}) {
  const resources = runtime || (await loadRuntime());
  signal?.throwIfAborted();
  const pluginDirectory = resolve(
    environment.APK_PLUGIN_DIR || join(options.dataDirectory, 'plugins'),
  );
  // 与发布目录同卷，但不放入插件扫描目录，避免服务启动看到半成品。
  const stagingRoot = join(dirname(pluginDirectory), `.${basename(pluginDirectory)}-install`);
  await mkdir(pluginDirectory, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const temporary = await mkdtemp(join(stagingRoot, 'install-'));
  let lock;
  try {
    const source = await sourceDirectory(options.source, temporary, signal);
    const staged = join(temporary, 'package');
    let packageRoot = staged;
    let relativePackageRoot = '';
    if (typeof source === 'string') {
      if (inside(await realpath(source), temporary))
        throw new Error('暂存目录不能位于插件源目录中');
      await copyPackage(source, staged, signal);
    } else {
      await mkdir(staged);
      // 保留 npm 原始平铺/嵌套依赖布局，作用域包与打包依赖都继续由 Node 正常解析。
      await copyPackage(source.modules, join(staged, 'node_modules'), signal);
      relativePackageRoot = join('node_modules', ...source.name.split('/'));
      packageRoot = join(staged, relativePackageRoot);
    }
    signal?.throwIfAborted();
    const stageManifest = await materializeManifest(packageRoot, packageRoot);
    const marketMetadata = await readMarketMetadata(packageRoot, stageManifest);
    const destination = join(pluginDirectory, stageManifest.id);
    const lockPath = join(stagingRoot, `lock-${stageManifest.id}`);
    try {
      await mkdir(lockPath);
      lock = lockPath;
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('同一插件安装已在进行，请等待或检查遗留锁');
      throw error;
    }
    try {
      await lstat(destination);
      throw new Error('相同 ID 的插件已经存在，本次安装不覆盖');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const checkPath = join(temporary, 'validate.json');
    await writeFile(checkPath, JSON.stringify(stageManifest));
    try {
      await promisify(execFile)(resources.validator, [checkPath], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 65536,
        signal,
      });
    } catch {
      throw new Error('Rust 宿主拒绝插件入口、协议、能力或输入模式');
    }
    const published = await materializeManifest(
      packageRoot,
      join(destination, relativePackageRoot),
    );
    await writeFile(join(staged, 'manifest.json'), JSON.stringify(published, null, 2), {
      flag: 'w',
    });
    // npm 入口可能位于 node_modules 深处，宿主始终从部署根读取展示资料。
    if (marketMetadata)
      await writeFile(join(staged, 'market.json'), JSON.stringify(marketMetadata, null, 2));
    signal?.throwIfAborted();
    // 禁止覆盖已存在目录，Windows/Unix 非空目录的原子 rename 都会拒绝竞争安装。
    await atomicRename(staged, destination);
    return {
      id: published.id,
      version: published.version,
      operations: published.operations.length,
      metadata_complete: marketMetadata !== null,
    };
  } finally {
    if (!inside(stagingRoot, temporary) || temporary === stagingRoot)
      throw new Error('安装清理路径越界');
    await rm(temporary, { recursive: true, force: true });
    if (lock) await rmdir(lock);
  }
}

export async function listPlugins(options, environment = process.env) {
  const directory = resolve(environment.APK_PLUGIN_DIR || join(options.dataDirectory, 'plugins'));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const manifest = await readJson(join(directory, entry.name, 'manifest.json'));
    const marketMetadata = await readMarketMetadata(join(directory, entry.name), manifest);
    result.push({
      id: manifest.id,
      version: manifest.version,
      protocol_version: manifest.protocol_version,
      operations: manifest.operations.length,
      metadata_complete: marketMetadata !== null,
    });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}
