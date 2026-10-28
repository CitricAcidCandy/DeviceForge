// 提前核对配置声明结构；完整 JSON Schema 语义仍由安装宿主验证。
import { utf8Length } from './encoding.mjs';
import { fields } from './market.mjs';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function configurationDefinition(value, componentId) {
  const label = `组件 ${componentId} configuration`;
  fields(value, ['version', 'schema', 'defaults', 'apply_policy', 'legacy_filename'], label);
  if (!Number.isInteger(value.version) || value.version < 1 || value.version > 0xffffffff)
    throw new Error(`${label}.version 必须为1至4294967295的整数`);
  if (!object(value.schema) || value.schema.type !== 'object')
    throw new Error(`${label}.schema 必须为 type:object 的 JSON Schema 对象`);
  if (!object(value.defaults)) throw new Error(`${label}.defaults 必须为对象`);
  const policy = value.apply_policy === undefined ? 'next_invocation' : value.apply_policy;
  if (!['next_invocation', 'plugin_reload'].includes(policy))
    throw new Error(`${label}.apply_policy 仅支持 next_invocation 或 plugin_reload`);
  const required = value.schema.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string') ||
      new Set(required).size !== required.length)
    throw new Error(`${label}.schema.required 必须为不重复的字段名数组`);
  // 默认配置可缺少使用者必填值；保存和运行时再校验完整模式，不强迫作者填示例地址。
  const legacy = value.legacy_filename;
  if (legacy !== undefined && legacy !== null && (typeof legacy !== 'string' || !legacy ||
      utf8Length(legacy) > 180 || /[/\\:]/.test(legacy) || legacy === '.' || legacy === '..'))
    throw new Error(`${label}.legacy_filename 必须为180字节以内、不含路径的文件名`);
  return { ...structuredClone(value), apply_policy: policy };
}
