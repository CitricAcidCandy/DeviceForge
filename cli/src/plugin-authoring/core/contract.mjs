import { utf8Length } from './encoding.mjs';
// 对齐 backend/domain/plugin_installations；源码模式允许尚未构建的空变体，成品严格拒绝缺项。
import { fixedVersion, sourceVersion } from './versions.mjs';
import { validateDependencies, marketDependencyResources } from './dependencies.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const id = (value) =>
  typeof value === 'string' &&
  /^[a-z0-9][a-z0-9._-]{0,98}$/.test(value) &&
  !value.startsWith('builtin.');
const pointer = (value) =>
  typeof value === 'string' &&
  value.length <= 512 &&
  value.startsWith('/') &&
  !/[\u0000-\u001f\u007f]/.test(value) &&
  !/~(?![01])/u.test(value);
const bytes = (value) => utf8Length(value, 'utf8');
export const RESOURCE_LIMIT = 2 * 1024 * 1024 * 1024;
export const OFFLINE_LIMIT = 4 * 1024 * 1024 * 1024;
export const EXPANDED_LIMIT = 8 * 1024 * 1024 * 1024;
export const MEMBER_LIMIT = 32768;

export function relativePath(value) {
  fail(
    typeof value === 'string' &&
      value.length > 0 &&
      bytes(value) <= 512 &&
      !/[\\:\u0000?#%]/.test(value) &&
      !value.startsWith('/'),
    '发布资源必须为有界相对路径',
  );
  for (const part of value.split('/'))
    fail(
      part &&
        part !== '.' &&
        part !== '..' &&
        !/[. ]$/.test(part) &&
        !/[\u0000-\u001f\u007f<>"|?*]/.test(part) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      '发布路径含越界或系统保留片段',
    );
  return value;
}
function fields(value, allowed, label) {
  fail(
    object(value) && Object.keys(value).every((key) => allowed.includes(key)),
    `${label}含未知字段或不是对象`,
  );
}
function variants(values, tool, source) {
  fail(
    Array.isArray(values) && values.length <= 32 && (source || tool || values.length > 0),
    '发布组件必须有归档变体',
  );
  const platforms = new Set();
  for (const value of values) {
    fields(
      value,
      ['platform', 'path', 'sha256', 'size', 'format', ...(tool ? ['entries'] : [])],
      '归档变体',
    );
    fail(
      typeof value.platform === 'string' &&
        (value.platform === 'any' ||
          (/^[a-z0-9-]{1,40}$/.test(value.platform) && value.platform.includes('-'))) &&
        !platforms.has(value.platform),
      '变体平台无效或重复',
    );
    platforms.add(value.platform);
    relativePath(value.path);
    fail(
      typeof value.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(value.sha256) &&
        !/^0{64}$/.test(value.sha256),
      '变体必须含真实小写 SHA-256',
    );
    fail(
      Number.isSafeInteger(value.size) && value.size > 0 && value.size <= RESOURCE_LIMIT,
      '归档大小必须为真实正整数且不超过2GiB',
    );
    fail(
      (tool ? ['zip', 'tgz', 'file'] : ['zip', 'tgz']).includes(value.format),
      '归档格式不受支持',
    );
    if (tool) {
      fail(
        object(value.entries) &&
          Object.keys(value.entries).length > 0 &&
          Object.keys(value.entries).length <= 128,
        '工具必须声明稳定资源入口',
      );
      for (const [key, path] of Object.entries(value.entries)) {
        fail(id(key), '工具资源键无效');
        relativePath(path);
        fail(value.format !== 'file' || path === 'payload', '单文件工具入口必须为 payload');
      }
    }
  }
}

export function validateRelease(value, { source = false } = {}) {
  fields(
    value,
    [
      'format_version',
      'host_api_version',
      'id',
      'version',
      'name',
      'description',
      'components',
      'tools',
      'requirements',
      'dependencies',
    ],
    '发布清单',
  );
  fail(
    [1, 2].includes(value.format_version) &&
      value.host_api_version === 2 &&
      id(value.id) &&
      fixedVersion(value.version),
    '发布身份或格式无效',
  );
  fail(
    typeof value.name === 'string' &&
      value.name.trim() &&
      bytes(value.name) <= 200 &&
      !/[\u0000-\u001f\u007f]/.test(value.name),
    '发布名称无效',
  );
  fail(
    typeof value.description === 'string' &&
      value.description.trim() &&
      bytes(value.description) <= 16384,
    '发布描述无效',
  );
  fail(
    Array.isArray(value.components) &&
      value.components.length > 0 &&
      value.components.length <= 32 &&
      (value.tools === undefined || (Array.isArray(value.tools) && value.tools.length <= 128)) &&
      (value.requirements === undefined ||
        (Array.isArray(value.requirements) && value.requirements.length <= 128)),
    '发布组件、工具或用户输入声明无效',
  );
  const components = new Set();
  for (const component of value.components) {
    fields(component, ['id', 'kind', 'version', 'variants'], '发布组件');
    fail(
      id(component.id) &&
        (source ? sourceVersion(component.version) : fixedVersion(component.version)) &&
        ['server', 'browser'].includes(component.kind) &&
        !components.has(component.id),
      '发布组件身份或类型无效',
    );
    components.add(component.id);
    variants(component.variants, false, source);
  }
  const tools = new Set(),
    bindings = new Set();
  fail(
    value.format_version !== 1 || value.dependencies === undefined,
    '第一版发布不接受第二版依赖声明',
  );
  if (value.format_version === 2)
    validateDependencies(value.dependencies ?? { format_version: 1, dependencies: [] }, {
      components,
    });
  for (const tool of value.tools ?? []) {
    fields(tool, ['id', 'version', 'required', 'variants', 'bindings'], '工具');
    fail(
      id(tool.id) &&
        (source ? sourceVersion(tool.version) : fixedVersion(tool.version)) &&
        !tools.has(tool.id) &&
        (tool.required === undefined || typeof tool.required === 'boolean') &&
        Array.isArray(tool.bindings) &&
        tool.bindings.length <= 128,
      '工具身份或依赖声明无效',
    );
    tools.add(tool.id);
    variants(tool.variants, true, source);
    fail(
      source || tool.required === false || tool.variants.length > 0,
      `必需工具没有真实资源变体：${tool.id}`,
    );
    for (const binding of tool.bindings) {
      fields(binding, ['component_id', 'config_pointer', 'entry'], '工具绑定');
      const target = `${binding.component_id}:${binding.config_pointer}`;
      fail(
        components.has(binding.component_id) &&
          pointer(binding.config_pointer) &&
          !bindings.has(target) &&
          id(binding.entry),
        '工具绑定组件、JSON Pointer 或目标无效',
      );
      fail(
        tool.variants.every((variant) => Object.hasOwn(variant.entries, binding.entry)),
        '工具绑定引用未声明的资源键',
      );
      bindings.add(target);
    }
  }
  for (const requirement of value.requirements ?? []) {
    fields(
      requirement,
      ['component_id', 'config_pointer', 'any_of', 'title', 'description', 'sensitive', 'required'],
      '用户输入',
    );
    fail(
      components.has(requirement.component_id) &&
        pointer(requirement.config_pointer) &&
        typeof requirement.title === 'string' &&
        requirement.title.trim() &&
        bytes(requirement.title) <= 200 &&
        typeof requirement.description === 'string' &&
        bytes(requirement.description) <= 4096 &&
        (requirement.required === undefined || typeof requirement.required === 'boolean') &&
        (requirement.sensitive === undefined || typeof requirement.sensitive === 'boolean'),
      '用户输入声明无效',
    );
    if (requirement.any_of !== undefined) {
      fail(
        Array.isArray(requirement.any_of) &&
          requirement.any_of.length <= 16 &&
          requirement.any_of.every(pointer) &&
          new Set([requirement.config_pointer, ...requirement.any_of]).size ===
            requirement.any_of.length + 1,
        '用户输入替代指针无效、重复或超过16项',
      );
    }
  }
  fail(bytes(JSON.stringify(value)) <= 256 * 1024, '发布清单超过256KiB');
  return value;
}

export function selectRelease(value, platform) {
  validateRelease(value);
  const choose = (variants_) =>
    variants_.find((item) => item.platform === platform) ??
    variants_.find((item) => item.platform === 'any');
  const components = value.components.map((component) => {
    const selected = choose(component.variants);
    fail(selected, `插件组件缺目标平台归档：${component.id}/${platform}`);
    return { ...component, variants: [selected] };
  });
  const tools = (value.tools ?? []).flatMap((tool) => {
    const selected = choose(tool.variants);
    fail(selected || tool.required === false, `必需工具缺目标平台归档：${tool.id}/${platform}`);
    return selected ? [{ ...tool, variants: [selected] }] : [];
  });
  return { ...value, components, tools };
}

export function releaseResources(value) {
  const resources = new Map();
  for (const variant of [
    ...value.components.flatMap((item) => item.variants),
    ...(value.tools ?? []).flatMap((item) => item.variants),
    ...marketDependencyResources(value),
  ]) {
    const previous = resources.get(variant.sha256);
    fail(!previous || previous.size === variant.size, '相同摘要声明了不同字节大小');
    resources.set(variant.sha256, variant);
  }
  return [...resources.values()];
}
