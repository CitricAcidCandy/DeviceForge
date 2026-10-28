// 只派生清单和身份包装；调用端负责收集文件与写入归档。
import { marketMetadata } from './market.mjs';

export function componentMetadata(declaration, component, dependencies) {
  const entrypoints = structuredClone(component.entrypoints);
  const plugin = { id: component.id, version: component.version, ...component.plugin };
  const generated = new Map();
  if (component.kind === 'browser') {
    plugin.api_version = 2;
    const path = entrypoints.any.path;
    const identity = { id: component.id, version: component.version, apiVersion: 2 };
    const configuration = component.plugin.configuration;
    generated.set('.deviceforge-entry.js', `import implementation from ${JSON.stringify('./' + path.split('/').map(encodeURIComponent).join('/'))};
const identity = Object.freeze(${JSON.stringify(identity)});
const plugin = typeof implementation === 'function' ? await implementation(identity) : implementation;
if (!plugin || typeof plugin !== 'object') throw new Error('浏览器插件必须返回对象');
for (const key of ['id', 'version', 'apiVersion']) {
  if (plugin[key] !== undefined && plugin[key] !== identity[key]) throw new Error('浏览器插件身份与开发清单冲突：' + key);
}
export default { panels: [], ...plugin, ...identity${configuration == null ? '' : `, configuration: ${JSON.stringify(configuration)}`} };
`);
    entrypoints.any.path = '.deviceforge-entry.js';
  } else {
    plugin.protocol_version ??= 1;
    plugin.args ??= [];
    plugin.operations ??= [];
  }
  const needed = new Set();
  for (const item of dependencies.dependencies) {
    if (item.bindings?.some((binding) => binding.component_id === component.id)) needed.add(item.id);
  }
  for (const entry of Object.values(entrypoints)) if (entry.dependency) needed.add(entry.dependency.id);
  for (const id of needed) {
    const item = dependencies.dependencies.find((item) => item.id === id);
    if (!item) throw new Error(`入口依赖未声明：${id}`);
    for (const child of item.requires ?? []) needed.add(child);
  }
  for (const entry of Object.values(entrypoints)) {
    if (entry.runtime !== 'script' && entry.dependency == null) continue;
    const reference = entry.dependency;
    if (entry.runtime === 'native' || !reference || !dependencies.dependencies.some((item) =>
      item.id === reference.id && item.required !== false && item.entries.includes(reference.entry)))
      throw new Error('脚本入口须引用组件依赖清单中的必需运行时及公开入口');
  }
  const componentDependencies = { format_version: 1, dependencies: dependencies.dependencies
    .filter((item) => needed.has(item.id)).map((item) => ({ ...item,
      bindings: (item.bindings ?? []).filter((binding) => binding.component_id === component.id),
    })) };
  const metadata = marketMetadata(declaration, component, { plugin_kind: component.kind });
  const pkg = { name: component.package_name, version: component.version, description: declaration.description,
    type: 'module', ...(metadata.license ? { license: metadata.license } : {}),
    deviceforge: { kind: component.kind, manifest: 'plugin.json', entrypoints } };
  const json = (value) => JSON.stringify(value, null, 2) + '\n';
  generated.set('package.json', json(pkg));
  generated.set('plugin.json', json(plugin));
  generated.set('market.json', json(metadata));
  if (componentDependencies.dependencies.length) generated.set('dependencies.json', json(componentDependencies));
  return generated;
}
