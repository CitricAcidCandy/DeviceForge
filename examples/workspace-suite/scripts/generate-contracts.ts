import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { generatePluginContracts } from '@deviceforge/plugin-tools';

const manifest: unknown = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const generated = generatePluginContracts(manifest);
const service = generated.services.find((entry) =>
  entry.id === 'example.workspace.normalize' && entry.version === '1');
if (!service) throw new Error('单一清单缺少示例的精确版本规范化服务');

// 只提供本工程的便捷名称；类型、模式和调用端均来自同一份清单。
const source = `${generated.source}\nexport {
  ${service.exportName} as normalizeContract,
  ${service.exportName}Submit as submitNormalize,
};
export type {
  ${service.exportName}Input as NormalizeInput,
  ${service.exportName}Output as NormalizeOutput,
};
`;
const target = new URL('../shared/service-contracts.ts', import.meta.url);
let previous: string | null = null;
try { previous = await readFile(target, 'utf8'); }
catch (error) {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
}
if (previous !== source) {
  await mkdir(new URL('../shared/', import.meta.url), { recursive: true });
  await writeFile(target, source, 'utf8');
}
