import { join } from 'node:path';
import { readJson, regularFile } from './paths.mjs';

const name = /^[a-z0-9][a-z0-9._-]{0,98}$/;
export async function materializeManifest(
  root,
  publishedRoot,
  platform = `${process.platform}-${process.arch}`,
) {
  const pkg = await readJson(join(root, 'package.json'));
  const descriptor = pkg.deviceforge;
  if (!descriptor || descriptor.kind !== 'server' || !descriptor.entrypoints)
    throw new Error('npm 包缺少服务器插件 deviceforge 声明');
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('插件包版本无效');
  const manifestPath = await regularFile(root, descriptor.manifest);
  const manifest = await readJson(manifestPath);
  if (
    typeof manifest.id !== 'string' ||
    !name.test(manifest.id) ||
    manifest.id.startsWith('builtin.') ||
    manifest.version !== pkg.version
  )
    throw new Error('插件 ID 无效或清单与 npm 包版本不一致');
  const entry = descriptor.entrypoints[platform] || descriptor.entrypoints.any;
  if (!entry || !['native', 'node'].includes(entry.runtime))
    throw new Error(`插件不支持当前平台 ${platform}`);
  await regularFile(root, entry.path);
  const args = manifest.args ?? [];
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))
    throw new Error('插件参数必须为字符串数组');
  // 发布清单由安装器生成绝对入口；便携清单不得携带机器相关程序位置。
  if (manifest.executable !== undefined)
    throw new Error('便携插件清单不应包含 executable，请使用 entrypoints 声明');
  const executable =
    entry.runtime === 'node' ? process.execPath : join(publishedRoot, ...entry.path.split('/'));
  return {
    ...manifest,
    executable,
    args:
      entry.runtime === 'node' ? [join(publishedRoot, ...entry.path.split('/')), ...args] : args,
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
    typeof metadata.name !== 'string' ||
    typeof metadata.summary !== 'string' ||
    typeof metadata.description !== 'string' ||
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
