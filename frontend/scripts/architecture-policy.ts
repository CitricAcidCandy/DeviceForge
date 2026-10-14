// 路径均相对 src；公开入口与组件私有文件按真实职责检查。
const featureFolders = new Set(['models', 'services', 'types', 'utils', 'components']);
const componentName = /^[A-Z][A-Za-z0-9]*$/;
const sourceFile = /\.(?:ts|tsx|js|mjs|cjs)$/;
function coreEntry(parts: readonly string[]): boolean {
  return parts.length === 3 && parts[0] === 'features' && parts[2] === 'index.ts';
}
function featureViewEntry(parts: readonly string[]): boolean {
  return parts.length === 4 && parts[0] === 'features' && parts[2] === 'components' && parts[3] === 'index.ts';
}
function publicComponentEntry(parts: readonly string[]): boolean {
  return parts[0] === 'components' && (parts.length === 2 && parts[1] === 'index.ts'
    || parts.length === 3 && componentName.test(parts[1] ?? '') && parts[2] === 'index.tsx');
}
function componentPlacement(parts: readonly string[], offset: number): boolean {
  return parts.length === offset + 1 && parts[offset] === 'index.ts'
    || parts.length >= offset + 2 && componentName.test(parts[offset] ?? '');
}
export function sourcePlacementIssue(file: string): string | null {
  if (!sourceFile.test(file)) return null;
  const parts = file.split('/');
  if (parts[0] === 'components') return componentPlacement(parts, 1) ? null : '公共组件放 components/<PascalCase组件>/index.tsx，根目录仅保留 index.ts 汇总';
  if (parts[0] !== 'features') return null;
  if (coreEntry(parts)) return null;
  if (parts.length < 4 || !featureFolders.has(parts[2] ?? '')) return '功能源码必须位于 models/services/types/utils/components，根目录仅保留 index.ts 核心入口';
  if (parts[2] === 'components' && !componentPlacement(parts, 3)) return '功能专属组件放 components/<PascalCase组件>/index.tsx，展示汇总为 components/index.ts';
  return null;
}
function componentDependency(origin: readonly string[], target: readonly string[]): boolean {
  if (target[0] === 'utils') return true;
  if (target[0] !== 'components') return false;
  if (origin.length === 2 && origin[1] === 'index.ts') return publicComponentEntry(target) && target.length === 3;
  if (target.length === 2) return false;
  return origin[1] === target[1] || publicComponentEntry(target);
}
function featureDependency(origin: readonly string[], target: readonly string[]): boolean {
  const from = origin[2] ?? '';
  if (target[0] === 'components') return from === 'components' && publicComponentEntry(target);
  if (target[0] === 'utils') return true;
  if (target[0] !== 'features') return ['shared', 'services', 'plugin-sdk'].includes(target[0] ?? '');
  if (origin[1] !== target[1]) return false;
  const to = target[2] ?? '';
  if (coreEntry(origin)) return coreEntry(target) || ['models', 'services', 'types', 'utils'].includes(to);
  if (!featureFolders.has(from) || !featureFolders.has(to)) return false;
  if (from === 'utils' || from === 'types') return to === 'utils' || to === 'types';
  if (from === 'services') return ['services', 'utils', 'types'].includes(to);
  if (from === 'models') return ['models', 'services', 'utils', 'types'].includes(to);
  return ['components', 'models', 'utils', 'types'].includes(to);
}
export function allowedDependency(from: string, to: string): boolean {
  const origin = from.split('/'); const target = to.split('/');
  const targetRoot = target[0] ?? '';
  switch (origin[0]) {
    case 'app': return targetRoot === 'features' ? coreEntry(target) || featureViewEntry(target)
      : targetRoot === 'components' ? publicComponentEntry(target) : ['app', 'utils', 'plugins', 'shared', 'services', 'plugin-sdk'].includes(targetRoot);
    case 'features': return featureDependency(origin, target);
    case 'components': return componentDependency(origin, target);
    case 'services': return ['services', 'shared', 'utils', 'plugin-sdk'].includes(targetRoot);
    case 'utils': return targetRoot === 'utils';
    case 'plugins': return ['plugins', 'plugin-sdk'].includes(targetRoot);
    case 'plugin-sdk': return targetRoot === 'plugin-sdk';
    case 'shared': return targetRoot === 'utils' || targetRoot === 'services' || targetRoot === 'shared' && (origin[1] !== 'ui' || target[1] === 'ui');
    case 'tests': return ['app', 'features', 'components', 'utils', 'plugins', 'shared', 'services', 'plugin-sdk'].includes(targetRoot);
    default: return false;
  }
}

export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const complete = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const failures: string[] = [];
  function visit(node: string): void {
    if (active.has(node)) { failures.push(`循环导入：${[...path.slice(path.indexOf(node)), node].join(' → ')}`); return; }
    if (complete.has(node)) return;
    active.add(node); path.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    path.pop(); active.delete(node); complete.add(node);
  }
  for (const node of graph.keys()) visit(node);
  return failures;
}
