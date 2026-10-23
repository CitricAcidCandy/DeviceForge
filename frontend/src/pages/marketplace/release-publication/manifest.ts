import type { ReleaseManifest, ReleaseVariant, ReleaseToolVariant } from './types.ts';
import { byteLength, fields, flag, identifier, list, pointer, relative, text, unique, version } from './manifest-fields.ts';

function variant(value: unknown, tool: boolean): ReleaseVariant {
  const item = fields(value, ['platform', 'path', 'sha256', 'size', 'format', ...(tool ? ['entries'] : [])], '资源变体');
  const platform = text(item.platform, 40, '平台');
  if (platform !== 'any' && (!/^[a-z0-9-]+$/.test(platform) || !platform.includes('-')))
    throw new Error('发布平台标识无效');
  const sha256 = text(item.sha256, 64, '资源摘要');
  if (!/^[a-f0-9]{64}$/.test(sha256) || /^0{64}$/.test(sha256))
    throw new Error('资源须提供真实小写 SHA-256');
  if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 2 ** 31)
    throw new Error('发布资源大小须在 2 GiB 以内');
  const format = item.format;
  if (format !== 'zip' && format !== 'tgz' && !(tool && format === 'file'))
    throw new Error('发布资源归档格式无效');
  return { platform, sha256, size: item.size, path: relative(item.path), format };
}

function toolVariant(value: unknown): ReleaseToolVariant {
  const base = variant(value, true);
  const item = fields(value, ['platform', 'path', 'sha256', 'size', 'format', 'entries'], '工具变体');
  const entries = item.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    throw new Error('工具缺少稳定资源入口');
  const pairs = Object.entries(entries);
  if (!pairs.length || pairs.length > 128) throw new Error('工具资源入口数量无效');
  return { ...base, entries: Object.fromEntries(pairs.map(([key, path]) => {
    const target = relative(path);
    if (base.format === 'file' && target !== 'payload') throw new Error('单文件工具入口必须为 payload');
    return [identifier(key), target];
  })) };
}

function component(value: unknown): ReleaseManifest['components'][number] {
  const item = fields(value, ['id', 'kind', 'version', 'variants'], '发布组件');
  const kind = item.kind;
  if (kind !== 'server' && kind !== 'browser') throw new Error('组件类型须为 server 或 browser');
  const variants = list(item.variants, 32, '组件变体', 1).map((entry) => variant(entry, false));
  unique(variants.map((entry) => entry.platform), '组件平台');
  return { id: identifier(item.id), kind, version: version(item.version), variants };
}

function tool(value: unknown): ReleaseManifest['tools'][number] {
  const item = fields(value, ['id', 'version', 'required', 'variants', 'bindings'], '发布工具');
  const required = flag(item.required, true);
  const variants = list(item.variants, 32, '工具变体', required ? 1 : 0).map(toolVariant);
  unique(variants.map((entry) => entry.platform), '工具平台');
  const bindings = list(item.bindings ?? [], 128, '工具绑定').map((value) => {
    const entry = fields(value, ['component_id', 'config_pointer', 'entry'], '工具绑定');
    return { component_id: identifier(entry.component_id), config_pointer: pointer(entry.config_pointer), entry: identifier(entry.entry) };
  });
  return { id: identifier(item.id), version: version(item.version), required, variants, bindings };
}

function requirement(value: unknown): ReleaseManifest['requirements'][number] {
  const item = fields(value, ['component_id', 'config_pointer', 'any_of', 'title', 'description', 'required', 'sensitive'], '用户输入');
  const config_pointer = pointer(item.config_pointer);
  const any_of = list(item.any_of ?? [], 16, '用户输入候选').map(pointer);
  unique([config_pointer, ...any_of], '用户输入候选');
  return {
    component_id: identifier(item.component_id), config_pointer, any_of,
    title: text(item.title, 200, '输入标题'), description: text(item.description ?? '', 4096, '输入描述', true),
    required: flag(item.required, true), sensitive: flag(item.sensitive, false),
  };
}

export function parseReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  if (bytes.byteLength > 256 * 1024) throw new Error('release.json 超过 256 KiB');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const item = fields(value, ['format_version', 'host_api_version', 'id', 'version', 'name', 'description', 'components', 'tools', 'requirements'], '发布清单');
  if (item.format_version !== 1 || item.host_api_version !== 2) throw new Error('发布格式或宿主 API 版本不受支持');
  const components = list(item.components, 32, '发布组件', 1).map(component);
  const tools = list(item.tools ?? [], 128, '发布工具').map(tool);
  const requirements = list(item.requirements ?? [], 128, '用户输入').map(requirement);
  unique(components.map((entry) => entry.id), '组件 ID');
  unique(tools.map((entry) => entry.id), '工具 ID');
  const componentIds = new Set(components.map((entry) => entry.id));
  const targets: string[] = [];
  for (const entry of tools) for (const binding of entry.bindings) {
    if (!componentIds.has(binding.component_id) || entry.variants.some((variant) => !Object.hasOwn(variant.entries, binding.entry)))
      throw new Error('工具绑定引用未知组件或未声明的资源入口');
    targets.push(`${binding.component_id}:${binding.config_pointer}`);
  }
  unique(targets, '工具绑定目标');
  if (requirements.some((entry) => !componentIds.has(entry.component_id))) throw new Error('用户输入引用未知组件');
  const name = text(item.name, 200, '发布名称');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('发布名称包含控制字符');
  const manifest: ReleaseManifest = {
    format_version: 1, host_api_version: 2, id: identifier(item.id), version: version(item.version),
    name, description: text(item.description, 16384, '发布描述'), components, tools, requirements,
  };
  if (byteLength(JSON.stringify(manifest)) > 256 * 1024) throw new Error('规范化发布清单超过 256 KiB');
  return manifest;
}

export function onlineManifest(manifest: ReleaseManifest): ReleaseManifest {
  return {
    ...manifest,
    components: manifest.components.map((entry) => ({ ...entry, variants: entry.variants.map((variant) => ({ ...variant, path: variant.sha256 })) })),
    tools: manifest.tools.map((entry) => ({ ...entry, variants: entry.variants.map((variant) => ({ ...variant, path: variant.sha256 })) })),
  };
}
