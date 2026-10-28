import { utf8Length } from './encoding.mjs';
// 开发清单归一化；旧安装包和宿主运行协议继续使用既有格式。
import { relativePath, validateRelease } from './contract.mjs';
import { fixedVersion } from './versions.mjs';
import { fields, text, marketMetadata } from './market.mjs';
import { configurationDefinition } from './configuration.mjs';

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,98}$/.test(value) || value.startsWith('builtin.'))
    throw new Error(`${label}须为字母开头、99 字节以内的小写标识`);
  return value;
}
function version(value) {
  if (!fixedVersion(value) || utf8Length(value) > 80) throw new Error('版本必须为80字节以内的固定版本');
  return value;
}
function component(value, source) {
  fields(value, ['id', 'kind', 'version', 'root', 'package_name', 'entrypoints', 'files', 'plugin'], '组件');
  if (!['server', 'browser'].includes(value.kind)) throw new Error('组件 kind 必须为 server 或 browser');
  const id = identifier(value.id ?? (source.components.length === 1 ? source.id : `${source.id}.${value.kind}`), '组件 ID');
  const root = value.root ?? '.';
  if (root !== '.') relativePath(root);
  const entrypoints = fields(value.entrypoints, Object.keys(value.entrypoints ?? {}), '组件 entrypoints');
  if (!Object.keys(entrypoints).length || Object.keys(entrypoints).length > 32) throw new Error('组件缺少平台入口或超过32项');
  for (const [platform, entry] of Object.entries(entrypoints)) {
    if (platform !== 'any' && !/^[a-z0-9]+-[a-z0-9-]+$/.test(platform)) throw new Error('组件平台无效');
    fields(entry, ['runtime', 'path', 'dependency'], '组件入口');
    if (!(value.kind === 'browser' ? entry.runtime === 'browser' && platform === 'any' :
      ['native', 'node', 'script'].includes(entry.runtime))) throw new Error('组件运行时与种类不符');
    relativePath(entry.path);
    if (/\.(?:tsx?|jsx|cjs)$/i.test(entry.path) && value.kind === 'browser') throw new Error('浏览器入口必须为已构建 ESM');
    if (entry.runtime === 'native' && platform === 'any') throw new Error('原生入口必须声明真实目标平台');
  }
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 256) throw new Error('组件 files 须显式列出1至256个文件或目录');
  value.files.forEach(relativePath);
  const plugin = structuredClone(fields(value.plugin ?? {}, value.kind === 'browser' ? ['api_version', 'configuration'] :
    ['protocol_version', 'args', 'operations', 'sessions', 'artifacts', 'devices', 'performance', 'configuration', 'recovery', 'services'], '组件 plugin'));
  if (plugin.configuration !== undefined && plugin.configuration !== null)
    plugin.configuration = configurationDefinition(plugin.configuration, id);
  if (value.kind === 'browser' && (plugin.api_version ?? 2) !== 2) throw new Error('浏览器 SDK 版本必须为2');
  if (value.kind === 'server' && (![1, 2, 3, 4, 6].includes(plugin.protocol_version ?? 1) ||
      !Array.isArray(plugin.operations ?? []))) throw new Error('任务协议或操作列表无效');
  const packageName = value.package_name ?? `deviceforge-plugin-${id}`;
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error('组件 npm 包名无效');
  return { ...value, id, version: version(value.version ?? source.version), root, package_name: packageName, plugin,
    entrypoints: structuredClone(entrypoints) };
}
export function normalizeManifest(value) {
  fields(value, ['manifest_version', 'id', 'version', 'name', 'description', 'market', 'components',
    'requirements', 'dependencies', 'dependency_files'], '插件开发清单');
  if (value.manifest_version !== 1) throw new Error('开发清单 manifest_version 必须为1');
  if (!Array.isArray(value.components) || !value.components.length || value.components.length > 32)
    throw new Error('开发清单须有1至32个组件');
  const declaration = { ...structuredClone(value), id: identifier(value.id, '功能 ID'), version: version(value.version),
    name: text(value.name, 160, '功能名称'), description: text(value.description, 16384, '功能描述', true) };
  declaration.components = value.components.map((item) => component(item, declaration));
  const ids = declaration.components.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('组件 ID 重复；同类多个组件请显式指定不同 ID');
  marketMetadata(declaration);
  const release = validateRelease({ format_version: 2, host_api_version: 2,
    id: declaration.id, version: declaration.version, name: declaration.name, description: declaration.description,
    components: declaration.components.map(({ id, kind, version }) => ({ id, kind, version, variants: [] })),
    tools: [], requirements: declaration.requirements ?? [],
    dependencies: declaration.dependencies ?? { format_version: 1, dependencies: [] },
  }, { source: true });
  const dependencyFiles = fields(declaration.dependency_files ?? {}, release.dependencies.dependencies.map((item) => item.id), 'dependency_files');
  for (const values of Object.values(dependencyFiles)) for (const entry of Array.isArray(values) ? values : [values]) {
    fields(entry, ['file', 'platform', 'version', 'format', 'entries', 'sha256', 'size'], '依赖本地输入');
    relativePath(entry.file);
  }
  return { ...declaration, release, dependency_files: dependencyFiles };
}
