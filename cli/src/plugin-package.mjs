import { join } from 'node:path';
import { readJson, regularFile } from './paths.mjs';

const name = /^[a-z0-9][a-z0-9._-]{0,98}$/;
const dependencyIdentifier = /^(?!builtin\.)[a-z0-9][a-z0-9._-]{0,98}$/;
const currentPlatform = () => `${process.platform}-${process.arch}`;

async function readDependencies(root) {
  let path;
  try {
    path = await regularFile(root, 'dependencies.json');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const manifest = await readJson(path, 1024 * 1024);
  const dependencies = manifest?.dependencies === undefined ? [] : manifest.dependencies;
  if (
    manifest?.format_version !== 1 ||
    !Array.isArray(dependencies) ||
    dependencies.length > 128
  )
    throw new Error('dependencies.json 版本或依赖列表无效');
  const ids = new Set();
  for (const dependency of dependencies) {
    if (
      !dependency ||
      typeof dependency.id !== 'string' ||
      !dependencyIdentifier.test(dependency.id) ||
      ids.has(dependency.id) ||
      (dependency.required !== undefined && typeof dependency.required !== 'boolean') ||
      !Array.isArray(dependency.entries) ||
      !dependency.entries.length ||
      dependency.entries.length > 64 ||
      new Set(dependency.entries).size !== dependency.entries.length ||
      dependency.entries.some((entry) => typeof entry !== 'string' || !dependencyIdentifier.test(entry))
    )
      throw new Error('dependencies.json 依赖标识、必需标记或公开入口无效');
    ids.add(dependency.id);
  }
  return { ...manifest, dependencies };
}

export async function readPluginDeployment(root, platform = currentPlatform()) {
  const pkg = await readJson(join(root, 'package.json'));
  const descriptor = pkg?.deviceforge;
  if (!descriptor || descriptor.kind !== 'server' || !descriptor.entrypoints)
    throw new Error('npm 包缺少服务器插件 deviceforge 声明');
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('插件包版本无效');
  const entry = descriptor.entrypoints[platform] || descriptor.entrypoints.any;
  if (!entry || !['native', 'node', 'script'].includes(entry.runtime))
    throw new Error(`插件不支持当前平台 ${platform}`);
  await regularFile(root, entry.path);
  if (['manifest.json', 'dependencies.json', '.deviceforge-runtime.json'].includes(entry.path))
    throw new Error('插件入口不得占用宿主生成清单或依赖元数据');
  const dependencies = await readDependencies(root);
  const reference = entry.dependency;
  let runtimeMetadata = null;
  if (reference !== undefined && reference !== null) {
    if (
      entry.runtime === 'native' ||
      typeof reference !== 'object' ||
      Array.isArray(reference) ||
      Object.keys(reference).some((key) => !['id', 'entry'].includes(key)) ||
      typeof reference.id !== 'string' ||
      !name.test(reference.id) || reference.id.startsWith('builtin.') ||
      typeof reference.entry !== 'string' ||
      !name.test(reference.entry) || reference.entry.startsWith('builtin.')
    )
      throw new Error('脚本运行时依赖引用的标识或入口无效，原生入口不得声明运行时依赖');
    const dependency = dependencies?.dependencies.find((dependency) => dependency.id === reference.id);
    if (!dependency || dependency.required === false || !dependency.entries.includes(reference.entry))
      throw new Error('脚本运行时必须引用 dependencies.json 中的必需依赖及其公开入口');
    runtimeMetadata = { format_version: 1, dependency: { id: reference.id, entry: reference.entry } };
  } else if (entry.runtime === 'script') {
    throw new Error('script 入口必须声明运行时依赖引用');
  }
  return { pkg, descriptor, entry, dependencies, runtimeMetadata };
}

export async function materializeManifest(
  root,
  publishedRoot,
  platform = currentPlatform(),
) {
  const { pkg, descriptor, entry, runtimeMetadata } = await readPluginDeployment(root, platform);
  const manifestPath = await regularFile(root, descriptor.manifest);
  const manifest = await readJson(manifestPath);
  if (
    typeof manifest.id !== 'string' ||
    !name.test(manifest.id) ||
    manifest.id.startsWith('builtin.') ||
    manifest.version !== pkg.version
  )
    throw new Error('插件 ID 无效或清单与 npm 包版本不一致');
  const args = manifest.args ?? [];
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))
    throw new Error('插件参数必须为字符串数组');
  // 便携清单不得携带机器程序位置；依赖运行时先用脚本静态校验，再由宿主快照映射。
  if (manifest.executable !== undefined)
    throw new Error('便携插件清单不应包含 executable，请使用 entrypoints 声明');
  const script = join(publishedRoot, ...entry.path.split('/'));
  const executable = entry.runtime === 'node' && !runtimeMetadata ? process.execPath : script;
  return {
    ...manifest,
    executable,
    args:
      entry.runtime !== 'native' ? [script, ...args] : args,
  };
}

const marketKinds = new Set(['plugin', 'tool', 'config', 'distribution', 'resource']);
const marketMcp = new Set(['none', 'client', 'server', 'both']);
const marketRestart = new Set([
  'none',
  'browser_refresh',
  'plugin_reload',
  'service_restart',
  'device_restart',
]);
const displayText = (value, maximum) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !value.includes('\0') &&
  Buffer.byteLength(value, 'utf8') <= maximum;

export async function readMarketMetadata(root, manifest) {
  let metadata;
  try {
    metadata = await readJson(join(root, 'market.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`market.json 读取失败：${error.message}`);
  }
  if (
    metadata?.metadata_version !== 1 ||
    metadata.id !== manifest.id ||
    metadata.version !== manifest.version ||
    !displayText(metadata.name, 200) ||
    !displayText(metadata.summary, 2000) ||
    !displayText(metadata.description, 20000) ||
    !marketKinds.has(metadata.kind) ||
    !Array.isArray(metadata.applies_to) ||
    !Array.isArray(metadata.keywords) ||
    !Array.isArray(metadata.categories) ||
    new Set(metadata.keywords).size !== metadata.keywords.length ||
    !marketMcp.has(metadata.supports_mcp) ||
    typeof metadata.supports_agent !== 'boolean' ||
    !marketRestart.has(metadata.restart_policy)
  )
    throw new Error('market.json 字段无效或与插件 manifest 不一致');
  return metadata;
}

export function validateRegistrySource(source) {
  // 本地目录/tgz 在调用处单独处理；在线只接受明确 npm 包及版本，不开放 Git/任意 URL。
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9.*+^~_-]*)?$/.test(
      source,
    )
  )
    throw new Error('在线插件来源必须为 npm 包名和可选版本，不接受 URL 或 Git 命令');
  return source;
}
