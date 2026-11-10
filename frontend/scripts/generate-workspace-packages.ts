import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePackagePaths, workspacePluginPackages } from './workspace-plugin-packages.ts';

/** 类型解析从同一份包出口派生，不让新增插件修改宿主手工路径表。 */
export function generateWorkspacePackagePaths(frontendRoot: string, check = false): boolean {
  const directory = workspacePluginPackages(frontendRoot);
  if (directory.diagnostics.length)
    throw new Error(directory.diagnostics.map((entry) => `${entry.project}：${entry.message}`).join('\n'));
  const value = `${JSON.stringify({ compilerOptions: { paths: {
    '/__production_host__': ['./src/app/public-runtime.ts'],
    '@/*': ['./src/*'],
    ...workspacePackagePaths(frontendRoot, directory),
  } } }, null, 2)}\n`;
  const path = resolve(frontendRoot, 'tsconfig.workspace-packages.json');
  if (existsSync(path) && readFileSync(path, 'utf8') === value) return false;
  if (check) throw new Error('工作区公开包类型目录已变化，请同步派生配置');
  writeFileSync(path, value, 'utf8');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  generateWorkspacePackagePaths(root, process.argv.includes('--check'));
}
