import { literal } from './json.js';
import type { ServiceDefinition } from './manifest.js';

/** 仅生成公开类型、元数据和一次 submit；不生成轮询、回执解码或新调用管线。 */
export function contractSource(services: readonly ServiceDefinition[]): string {
  const header = '// 由 manifest.json 生成；请修改清单后重新生成，不维护第二份契约。\n';
  if (!services.length) return header + 'export {};\n';
  const types = ['HostResult', 'Job', 'ServerServiceAccess', 'ServiceContract', 'ServiceRef'];
  if (services.some((service) => /\bJsonValue\b/u.test(service.inputType + service.outputType)))
    types.push('JsonValue');
  const sections = [header +
    `import type { ${types.sort().join(', ')} } from "@deviceforge/plugin-sdk";\n` +
    '// 类型只表达数据结构；长度、正则和数值范围仍以原 Schema 在运行期校验。'];
  for (const service of services) {
    const name = service.exportName;
    sections.push([
      `export type ${name}Input = ${service.inputType};`,
      `export type ${name}Output = ${service.outputType};`,
      `export const ${name}Ref: ServiceRef = ${literal({ id: service.id, version: service.version })};`,
      `export const ${name}Schema: ServiceContract = ${literal({
        inputSchema: service.inputSchema, outputSchema: service.outputSchema,
      })};`,
      `export const ${name}: ServiceContract & { readonly ref: ServiceRef; readonly operation: string } = {`,
      `  ref: ${name}Ref,`,
      `  ...${name}Schema,`,
      `  operation: ${JSON.stringify(service.operation)},`,
      '};',
      '',
      '/** 只提交一次并原样返回 Job 回执；业务终态需要调用方按原票据另行查询。 */',
      `export function ${name}Submit(`,
      '  server: ServerServiceAccess,',
      `  input: ${name}Input,`,
      '  signal: AbortSignal,',
      '  generation?: string,',
      '): Promise<HostResult<Job>> {',
      `  return server.submit(${name}Ref, input, signal, generation);`,
      '}',
    ].join('\n'));
  }
  return sections.join('\n\n') + '\n';
}
