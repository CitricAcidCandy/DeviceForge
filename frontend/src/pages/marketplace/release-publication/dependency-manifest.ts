import { isDependencyIdentifier } from '../../../services/api/index.ts';
import { fields, flag, list, pointer, relative, text, unique } from './manifest-fields.ts';
import type { ReleaseDependency, ReleaseDependencyManifest, ReleaseDependencySource } from './dependency-types.ts';

function entryId(value: unknown): string {
  if (!isDependencyIdentifier(value)) throw new Error('依赖标识须为 99 字节以内的小写字母、数字及 ._-，以字母或数字开头且不含保留前缀');
  return value;
}
function entryMap(value: unknown, entries: readonly string[], allowDot: boolean, complete: boolean): Record<string, string> {
  const item = fields(value, entries, '依赖入口映射');
  const pairs = Object.entries(item);
  if (pairs.length > 64 || (complete ? entries.some((entry) => !Object.hasOwn(item, entry)) : !pairs.length))
    throw new Error('依赖入口映射不完整或数量无效');
  return Object.fromEntries(pairs.map(([key, value]) => [key, allowDot && value === '.' ? '.' : relative(value)]));
}
function source(value: unknown, entries: readonly string[]): ReleaseDependencySource {
  const item = fields(value, ['kind', 'url', 'platform', 'version', 'sha256', 'size', 'format', 'entries'], '依赖来源');
  if (item.kind !== 'market' && item.kind !== 'official') throw new Error('依赖来源类型无效');
  const url = text(item.url, 2048, '依赖来源地址');
  if (/[\u0000-\u001f\u007f]/.test(url)) throw new Error('依赖来源地址包含控制字符');
  if (item.kind === 'official' || /^https?:\/\//.test(url)) {
    const parsed = new URL(url);
    if (!['https:', ...(item.kind === 'market' ? ['http:'] : [])].includes(parsed.protocol) ||
      !parsed.hostname || parsed.username || parsed.password || parsed.hash || (item.kind === 'market' && parsed.search))
      throw new Error('官方依赖须为无凭据 HTTPS，市场来源须为无查询的摘要资源地址');
    if (item.kind === 'market' && parsed.pathname !== `/api/v1/resources/${item.sha256}`)
      throw new Error('市场远端依赖来源必须为摘要资源地址');
  } else relative(url);
  const platform = text(item.platform, 40, '依赖平台');
  if (!/^[A-Za-z0-9-]+$/.test(platform)) throw new Error('依赖平台无效');
  const version = text(item.version, 100, '依赖固定版本');
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error('依赖固定版本无效');
  const sha256 = text(item.sha256, 64, '依赖摘要');
  if (!/^[a-f0-9]{64}$/.test(sha256) || /^0{64}$/.test(sha256)) throw new Error('依赖须提供真实小写 SHA-256');
  if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 2 ** 31)
    throw new Error('依赖资源大小须在 2 GiB 以内');
  if (item.format !== 'zip' && item.format !== 'tgz' && item.format !== 'file') throw new Error('依赖归档格式无效');
  return { kind: item.kind, url, platform, version, sha256, size: item.size, format: item.format,
    entries: entryMap(item.entries, entries, false, true) };
}
function dependency(value: unknown, components: ReadonlySet<string>): ReleaseDependency {
  const item = fields(value, ['id', 'name', 'version_requirement', 'required', 'entries', 'requires', 'discovery', 'probe', 'sources', 'bindings'], '依赖声明');
  const entries = list(item.entries, 64, '依赖入口', 1).map(entryId);
  unique(entries, '依赖入口');
  const requires = list(item.requires ?? [], 128, '配套依赖').map(entryId);
  unique(requires, '配套依赖');
  const discovery = list(item.discovery ?? [], 32, '发现规则').map((value): ReleaseDependency['discovery'][number] => {
    const rule = fields(value, ['kind', 'value', 'entries'], '发现规则');
    const kind = rule.kind;
    if (kind !== 'environment' && kind !== 'path' && kind !== 'user_directory') throw new Error('依赖发现类型无效');
    const name = text(rule.value, kind === 'user_directory' ? 512 : 128, '依赖发现位置');
    if ((kind === 'environment' && !/^[A-Za-z0-9_]+$/.test(name)) ||
      (kind === 'path' && (/[\\/:\s\u0000-\u001f\u007f]/.test(name) || name.startsWith('-'))))
      throw new Error('依赖发现变量或程序名无效');
    if (kind === 'user_directory' && name !== '.') relative(name);
    return { kind, value: name, entries: entryMap(rule.entries, entries, true, false) };
  });
  let probe: ReleaseDependency['probe'] = null;
  if (item.probe !== undefined && item.probe !== null) {
    const value = fields(item.probe, ['entry', 'args', 'pattern', 'timeout_ms'], '版本探测');
    const entry = entryId(value.entry);
    const timeout_ms = value.timeout_ms ?? 3000;
    if (!entries.includes(entry) || typeof timeout_ms !== 'number' || !Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 10000)
      throw new Error('依赖版本探测入口或期限无效');
    probe = { entry, timeout_ms, pattern: text(value.pattern, 2048, '版本探测表达式'),
      args: list(value.args ?? [], 32, '版本探测参数').map((arg) => {
        const result = text(arg, 4096, '版本探测参数', true);
        if (result.includes('\0')) throw new Error('版本探测参数包含空字符');
        return result;
      }) };
  }
  const bindings = list(item.bindings ?? [], 64, '依赖绑定').map((value) => {
    const binding = fields(value, ['component_id', 'config_pointer', 'entry'], '依赖绑定');
    const component_id = entryId(binding.component_id), entry = entryId(binding.entry);
    if (!components.has(component_id) || !entries.includes(entry)) throw new Error('依赖绑定引用未知组件或入口');
    return { component_id, entry, config_pointer: pointer(binding.config_pointer) };
  });
  return { id: entryId(item.id), name: text(item.name, 200, '依赖名称'),
    version_requirement: text(item.version_requirement, 128, '依赖版本范围'), required: flag(item.required, true),
    entries, requires, discovery, probe, bindings, sources: list(item.sources ?? [], 32, '依赖来源').map((value) => source(value, entries)) };
}

export function parseDependencyManifest(value: unknown, components: ReadonlySet<string>): ReleaseDependencyManifest {
  const item = fields(value, ['format_version', 'dependencies'], '统一依赖清单');
  if (item.format_version !== 1) throw new Error('统一依赖清单版本不受支持');
  const dependencies = list(item.dependencies ?? [], 128, '统一依赖').map((value) => dependency(value, components));
  unique(dependencies.map((item) => item.id), '依赖标识');
  const graph = new Map(dependencies.map((item) => [item.id, item.requires]));
  const done = new Set<string>(), active = new Set<string>();
  function visit(id: string): void {
    if (done.has(id)) return;
    if (active.has(id)) throw new Error('配套依赖存在循环');
    const children = graph.get(id);
    if (!children) throw new Error('配套依赖引用未声明的依赖');
    active.add(id);
    children.forEach(visit);
    active.delete(id);
    done.add(id);
  }
  dependencies.forEach((item) => visit(item.id));
  return { format_version: 1, dependencies };
}

export function isRemoteDependencySource(value: ReleaseDependencySource): boolean {
  return value.url === value.sha256 || value.url === `blobs/${value.sha256}` || /^https?:\/\//.test(value.url);
}
