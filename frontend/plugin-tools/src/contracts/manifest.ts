import { fields, invalid, manifestJson, object, text } from './json.js';
import type { ContractJson, ContractObject } from './json.js';
import type { GeneratedPluginService } from './types.js';
import { schemaType } from './schema.js';

export interface ServiceDefinition extends GeneratedPluginService {
  readonly inputSchema: ContractJson;
  readonly outputSchema: ContractJson;
  readonly inputType: string;
  readonly outputType: string;
}
function identifier(value: ContractJson | undefined, path: string, maximum = 200) {
  const id = text(value, path);
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/u.test(id) || id.length > maximum)
    invalid(path, '标识须为字母开头的 ASCII 字母、数字、点、横线或下划线');
  return id;
}
function version(value: ContractJson | undefined, path: string) {
  const result = text(value, path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/u.test(result))
    invalid(path, '只接受 80 字符以内的固定精确版本，不接受范围');
  return result;
}
function exportPart(value: string) {
  return value.split(/[^a-zA-Z0-9]+/u).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}
function operations(plugin: ContractObject, path: string) {
  const declarations = plugin.operations === undefined ? [] : plugin.operations;
  if (!Array.isArray(declarations) || declarations.length > 256)
    invalid(`${path}.operations`, '操作列表必须是至多 256 项的数组');
  const result = new Map<string, ContractObject>();
  for (const [index, declaration] of declarations.entries()) {
    const operation = object(declaration, `${path}.operations[${index}]`);
    const name = identifier(operation.name, `${path}.operations[${index}].name`);
    if (result.has(name)) invalid(`${path}.operations[${index}]`, '操作名称重复');
    result.set(name, operation);
  }
  return result;
}

/** 仅校验生成所需的单清单边界，完整发布校验仍由公开打包工具负责。 */
export function manifestServices(input: unknown): readonly ServiceDefinition[] {
  const manifest = object(manifestJson(input), 'manifest');
  if (manifest.manifest_version !== 1) invalid('manifest.manifest_version', '仅支持单清单版本 1');
  const manifestId = identifier(manifest.id, 'manifest.id', 99);
  version(manifest.version, 'manifest.version');
  if (!Array.isArray(manifest.components) || !manifest.components.length || manifest.components.length > 32)
    invalid('manifest.components', '必须包含 1 至 32 个组件');
  const componentIds = new Set<string>(), serviceIds = new Set<string>(), exportNames = new Set<string>();
  const services: ServiceDefinition[] = [];
  for (const [componentIndex, raw] of manifest.components.entries()) {
    const path = `manifest.components[${componentIndex}]`, component = object(raw, path);
    if (component.kind !== 'server' && component.kind !== 'browser') invalid(`${path}.kind`, '只支持 server 或 browser');
    const defaultId = manifest.components.length === 1 ? manifestId : `${manifestId}.${component.kind}`;
    const componentId = identifier(component.id === undefined ? defaultId : component.id, `${path}.id`, 99);
    if (componentIds.has(componentId)) invalid(`${path}.id`, '组件身份重复');
    componentIds.add(componentId);
    if (component.kind === 'browser') continue;
    const plugin = component.plugin === undefined ? {} : object(component.plugin, `${path}.plugin`);
    const declaredOperations = operations(plugin, `${path}.plugin`);
    if (plugin.services === undefined) continue;
    const declaration = object(plugin.services, `${path}.plugin.services`);
    const provided = declaration.provided === undefined ? [] : declaration.provided;
    if (!Array.isArray(provided) || provided.length > 256)
      invalid(`${path}.plugin.services.provided`, '必须是至多 256 项的数组');
    for (const [index, rawService] of provided.entries()) {
      const servicePath = `${path}.plugin.services.provided[${index}]`, entry = object(rawService, servicePath);
      fields(entry, ['service', 'operation', 'contract'], servicePath);
      const reference = object(entry.service, `${servicePath}.service`);
      fields(reference, ['id', 'version'], `${servicePath}.service`);
      const id = identifier(reference.id, `${servicePath}.service.id`);
      const serviceVersion = version(reference.version, `${servicePath}.service.version`);
      const localOperation = identifier(entry.operation, `${servicePath}.operation`);
      const operation = declaredOperations.get(localOperation);
      if (!operation) invalid(`${servicePath}.operation`, '服务必须映射当前服务器组件已声明的普通操作');
      const identity = JSON.stringify([id, serviceVersion]);
      if (serviceIds.has(identity)) invalid(servicePath, '精确版本服务身份重复');
      serviceIds.add(identity);
      const exportName = `${exportPart(id)}V${exportPart(serviceVersion)}`;
      for (const suffix of ['', 'Ref', 'Schema', 'Submit', 'Input', 'Output']) {
        const symbol = exportName + suffix;
        if (exportNames.has(symbol)) invalid(servicePath, `导出名称发生碰撞：${symbol}`);
        exportNames.add(symbol);
      }
      const contract = object(entry.contract, `${servicePath}.contract`);
      fields(contract, ['input_schema', 'output_schema'], `${servicePath}.contract`);
      const inputSchema = contract.input_schema, outputSchema = contract.output_schema;
      if (inputSchema === undefined || outputSchema === undefined)
        invalid(`${servicePath}.contract`, '必须显式提供 input_schema 和 output_schema');
      const inputType = schemaType(inputSchema, `${servicePath}.contract.input_schema`);
      const outputType = schemaType(outputSchema, `${servicePath}.contract.output_schema`);
      if (operation.input_schema !== undefined &&
          JSON.stringify(operation.input_schema) !== JSON.stringify(inputSchema))
        invalid(`${servicePath}.contract.input_schema`, '输入 Schema 与对应操作 input_schema 不一致');
      services.push({
        id, version: serviceVersion, operation: `plugin.${componentId}.${localOperation}`, exportName,
        inputSchema, outputSchema, inputType, outputType,
      });
    }
  }
  return services.sort((left, right) => {
    const a = JSON.stringify([left.id, left.version, left.operation]);
    const b = JSON.stringify([right.id, right.version, right.operation]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
