import { utf8Length } from './encoding.mjs';
// 对齐公开 plugin-dependencies 契约；仅校验声明，不读取环境或执行探测。
import { relativePath, RESOURCE_LIMIT } from './contract.mjs';
import { fixedVersion, sourceVersion } from './versions.mjs';
import semver from 'semver';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const key = (value) => typeof value === 'string' &&
  /^[a-z0-9][a-z0-9._-]{0,98}$/.test(value) && !value.startsWith('builtin.');
const text = (value, maximum) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  utf8Length(value) <= maximum &&
  !/[\u0000-\u001f\u007f]/.test(value);
const fields = (value, allowed, label) =>
  fail(
    object(value) && Object.keys(value).every((name) => allowed.includes(name)),
    `${label}含未知字段或不是对象`,
  );
const list = (value, maximum, label) => {
  fail(Array.isArray(value) && value.length <= maximum, `${label}数组无效或超限`);
  return value;
};
const pointer = (value) => text(value, 512) && value.startsWith('/') && !/~(?![01])/u.test(value);

function entryMap(value, declared, { discovery = false, singleFile = false } = {}) {
  fail(
    object(value) &&
      Object.keys(value).length > 0 &&
      Object.keys(value).length <= 64 &&
      Object.keys(value).every((name) => declared.includes(name)) &&
      (discovery || declared.every((name) => Object.hasOwn(value, name))),
    '依赖入口必须映射声明的稳定键',
  );
  for (const path of Object.values(value)) {
    if (!(discovery && path === '.')) relativePath(path);
    fail(!singleFile || path === 'payload', '单文件依赖入口必须为 payload');
  }
}

export function dependencyUrl(source) {
  fail(text(source.url, 2048), '依赖来源地址无效');
  let url;
  try {
    url = new URL(source.url);
  } catch {
    fail(source.kind === 'market', '依赖来源地址无效');
    relativePath(source.url);
    return null;
  }
  fail(
    (source.kind === 'official'
      ? url.protocol === 'https:'
      : ['http:', 'https:'].includes(url.protocol)) &&
      !url.username &&
      !url.password &&
      !url.hash,
    '官方依赖须使用无凭据 HTTPS，市场来源须为 HTTP/HTTPS',
  );
  return url;
}

export function compatibleDependencyVersion(requirement, actual) {
  if (requirement === '*') return fixedVersion(actual);
  const normalized = requirement.replaceAll(',', ' ');
  if (semver.valid(actual) && semver.validRange(normalized))
    return semver.satisfies(actual, semver.valid(normalized) ? `^${normalized}` : normalized);
  return requirement.replace(/^=/, '').trim() === actual;
}

export function validateDependencies(value, { components, owner } = {}) {
  fields(value, ['format_version', 'dependencies'], '依赖清单');
  fail(value.format_version === 1, '依赖清单版本必须为1');
  const dependencies = list(value.dependencies ?? [], 128, '依赖');
  const ids = new Set(),
    targets = new Set();
  for (const item of dependencies) {
    fields(
      item,
      [
        'id',
        'name',
        'version_requirement',
        'required',
        'entries',
        'requires',
        'discovery',
        'probe',
        'sources',
        'bindings',
      ],
      '依赖',
    );
    fail(
      key(item.id) &&
        !ids.has(item.id) &&
        text(item.name, 200) &&
        typeof item.version_requirement === 'string' &&
        item.version_requirement.length <= 128 &&
        sourceVersion(item.version_requirement.replaceAll(',', ' ').replace(/^=/, '')) &&
        item.version_requirement !== 'unresolved' &&
        (item.required === undefined || typeof item.required === 'boolean'),
      '依赖身份、版本范围或必需标志无效',
    );
    ids.add(item.id);
    list(item.entries, 64, '依赖入口');
    fail(
      item.entries.length > 0 &&
        item.entries.every(key) &&
        new Set(item.entries).size === item.entries.length,
      '依赖稳定入口无效或重复',
    );
    const requires = list(item.requires ?? [], 128, '前置依赖');
    fail(requires.every(key) && new Set(requires).size === requires.length, '前置依赖无效或重复');
    for (const rule of list(item.discovery ?? [], 32, '依赖发现')) {
      fields(rule, ['kind', 'value', 'entries'], '依赖发现');
      fail(
        ['environment', 'path', 'user_directory'].includes(rule.kind) && text(rule.value, 512),
        '依赖发现类型或值无效',
      );
      if (rule.kind === 'environment')
        fail(rule.value.length <= 128 && /^[A-Za-z0-9_]+$/.test(rule.value), '依赖环境变量名无效');
      else if (rule.kind === 'path')
        fail(
          rule.value.length <= 128 && !/[\\/:\s]/.test(rule.value) && !rule.value.startsWith('-'),
          'PATH 发现必须为程序名',
        );
      else if (rule.value !== '.') relativePath(rule.value);
      entryMap(rule.entries, item.entries, { discovery: true });
    }
    if (item.probe != null) {
      const probe = item.probe;
      fields(probe, ['entry', 'args', 'pattern', 'timeout_ms'], '依赖版本探测');
      fail(
        item.entries.includes(probe.entry) &&
          text(probe.pattern, 2048) &&
          /\((?!\?[:=!<])/.test(probe.pattern) &&
          list(probe.args ?? [], 32, '探测参数').every(
            (arg) =>
              typeof arg === 'string' && utf8Length(arg) <= 4096 && !arg.includes('\0'),
          ) &&
          Number.isSafeInteger(probe.timeout_ms ?? 3000) &&
          (probe.timeout_ms ?? 3000) > 0 &&
          (probe.timeout_ms ?? 3000) <= 10000,
        '依赖版本探测无效',
      );
    }
    for (const source of list(item.sources ?? [], 32, '依赖来源')) {
      fields(
        source,
        ['kind', 'url', 'platform', 'version', 'sha256', 'size', 'format', 'entries'],
        '依赖来源',
      );
      fail(
        ['market', 'official'].includes(source.kind) &&
          text(source.platform, 40) &&
          /^[A-Za-z0-9-]+$/.test(source.platform) &&
          fixedVersion(source.version) &&
          compatibleDependencyVersion(item.version_requirement, source.version),
        '依赖来源平台或固定版本无效',
      );
      dependencyUrl(source);
      fail(
        typeof source.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(source.sha256) &&
          !/^0{64}$/.test(source.sha256) &&
          Number.isSafeInteger(source.size) &&
          source.size > 0 &&
          source.size <= RESOURCE_LIMIT &&
          ['zip', 'tgz', 'file'].includes(source.format),
        '依赖来源摘要、大小或归档格式无效',
      );
      entryMap(source.entries, item.entries, { singleFile: source.format === 'file' });
    }
    for (const binding of list(item.bindings ?? [], 64, '依赖绑定')) {
      fields(binding, ['component_id', 'config_pointer', 'entry'], '依赖绑定');
      const component = binding.component_id || owner;
      fail(
        (!component || key(component)) &&
          (!components || components.has(component)) &&
          pointer(binding.config_pointer) &&
          item.entries.includes(binding.entry),
        '依赖绑定组件、指针或入口无效',
      );
      const target = `${component ?? ''}:${binding.config_pointer}`;
      fail(!targets.has(target), '依赖绑定目标重复');
      targets.add(target);
    }
  }
  const visited = new Set(),
    visiting = new Set(),
    byId = new Map(dependencies.map((item) => [item.id, item]));
  const visit = (item) => {
    fail(!visiting.has(item.id), '依赖图存在循环');
    if (visited.has(item.id)) return;
    visiting.add(item.id);
    for (const id of item.requires ?? []) {
      fail(byId.has(id), '前置依赖不存在');
      visit(byId.get(id));
    }
    visiting.delete(item.id);
    visited.add(item.id);
  };
  for (const item of dependencies) visit(item);
  fail(utf8Length(JSON.stringify(value)) <= 256 * 1024, '依赖清单超过256KiB');
  return value;
}

export function marketDependencyResources(manifest) {
  return (manifest.dependencies?.dependencies ?? []).flatMap((item) =>
    (item.sources ?? [])
      .filter((source) => source.kind === 'market')
      .map((source) => ({ ...source, path: `blobs/${source.sha256}` })),
  );
}
