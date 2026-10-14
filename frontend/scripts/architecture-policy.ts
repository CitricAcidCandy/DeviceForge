// 路径相对 src；页面就近组织，features 只保存跨页面非展示能力。
const featureFolders = new Set(['models', 'services', 'types', 'utils']);
const componentName = /^[A-Z][A-Za-z0-9]*$/;
const sourceFile = /\.(?:ts|tsx|js|mjs|cjs)$/;
function featureEntry(parts: readonly string[]): boolean {
  return parts.length === 3 && parts[0] === 'features' && parts[2] === 'index.ts';
}
function pageEntry(parts: readonly string[]): boolean {
  return parts.length === 3 && parts[0] === 'pages' && parts[2] === 'index.tsx';
}
function publicComponentEntry(parts: readonly string[]): boolean {
  return (
    parts[0] === 'components' &&
    ((parts.length === 2 && parts[1] === 'index.ts') ||
      (parts.length === 3 && componentName.test(parts[1] ?? '') && parts[2] === 'index.tsx'))
  );
}
function componentPlacement(parts: readonly string[]): boolean {
  return (
    (parts.length === 2 && parts[1] === 'index.ts') ||
    (parts.length >= 3 && componentName.test(parts[1] ?? ''))
  );
}
export function sourcePlacementIssue(file: string): string | null {
  if (!sourceFile.test(file)) return null;
  const parts = file.split('/');
  if (parts[0] === 'components')
    return componentPlacement(parts)
      ? null
      : '跨页面公共组件放 components/<PascalCase组件>/index.tsx，根目录仅保留 index.ts 汇总';
  if (parts[0] === 'pages')
    return parts.length >= 3
      ? null
      : '路由页面放 pages/<功能页>/index.tsx，私有组件和文件留页面目录';
  if (parts[0] !== 'features') return null;
  if (file.endsWith('.tsx')) return 'features 只保留跨页面业务逻辑，业务 UI 必须归属 pages';
  if (featureEntry(parts)) return null;
  if (parts.length < 4 || !featureFolders.has(parts[2] ?? ''))
    return 'features 源码只位于 models/services/types/utils，根目录仅保留 index.ts 核心入口';
  return null;
}
function componentDependency(origin: readonly string[], target: readonly string[]): boolean {
  if (target[0] === 'utils') return true;
  if (target[0] !== 'components') return false;
  if (origin.length === 2 && origin[1] === 'index.ts')
    return publicComponentEntry(target) && target.length === 3;
  if (target.length === 2) return false;
  return origin[1] === target[1] || publicComponentEntry(target);
}
function featureDependency(origin: readonly string[], target: readonly string[]): boolean {
  const from = origin[2] ?? '';
  if (target[0] === 'utils') return true;
  if (target[0] !== 'features')
    return ['shared', 'services', 'plugin-sdk'].includes(target[0] ?? '');
  if (origin[1] !== target[1]) return featureEntry(target);
  const to = target[2] ?? '';
  if (featureEntry(origin)) return featureEntry(target) || featureFolders.has(to);
  if (!featureFolders.has(from) || !featureFolders.has(to)) return false;
  if (from === 'utils' || from === 'types') return to === 'utils' || to === 'types';
  if (from === 'services') return ['services', 'utils', 'types'].includes(to);
  return ['models', 'services', 'utils', 'types'].includes(to);
}
// 迁移期仅保留既有页面支撑文件，避免目录整理扩大为业务重构。
const pageSupportFiles = new Set([
  'services.ts',
  'hooks.ts',
  'feedback.tsx',
  'capabilities.tsx',
  'device-target.ts',
]);
function pageDependency(origin: readonly string[], target: readonly string[]): boolean {
  const targetRoot = target[0] ?? '';
  if (targetRoot === 'pages') return origin[1] === target[1];
  if (targetRoot === 'app')
    return target.length === 3 && target[1] === 'product' && pageSupportFiles.has(target[2] ?? '');
  if (targetRoot === 'features') return featureEntry(target);
  if (targetRoot === 'components') return publicComponentEntry(target);
  if (targetRoot === 'services') return target[1] === 'api';
  if (targetRoot === 'shared')
    return target.length === 3 && target[1] === 'jobs' && target[2] === 'index.ts';
  if (targetRoot === 'plugin-sdk')
    return target.length === 2 && ['index.ts', 'json.ts'].includes(target[1] ?? '');
  return targetRoot === 'utils';
}
export function allowedDependency(from: string, to: string): boolean {
  const origin = from.split('/');
  const target = to.split('/');
  const targetRoot = target[0] ?? '';
  switch (origin[0]) {
    case 'app':
      return targetRoot === 'pages'
        ? pageEntry(target)
        : targetRoot === 'features'
          ? featureEntry(target)
          : targetRoot === 'components'
            ? publicComponentEntry(target)
            : ['app', 'utils', 'plugins', 'shared', 'services', 'plugin-sdk'].includes(targetRoot);
    case 'pages':
      return pageDependency(origin, target);
    case 'features':
      return featureDependency(origin, target);
    case 'components':
      return componentDependency(origin, target);
    case 'services':
      return ['services', 'shared', 'utils', 'plugin-sdk'].includes(targetRoot);
    case 'utils':
      return targetRoot === 'utils';
    case 'plugins':
      return ['plugins', 'plugin-sdk'].includes(targetRoot);
    case 'plugin-sdk':
      return targetRoot === 'plugin-sdk';
    case 'shared':
      return (
        targetRoot === 'utils' ||
        targetRoot === 'services' ||
        (targetRoot === 'shared' && (origin[1] !== 'ui' || target[1] === 'ui'))
      );
    case 'tests':
      return [
        'app',
        'pages',
        'features',
        'components',
        'utils',
        'plugins',
        'shared',
        'services',
        'plugin-sdk',
      ].includes(targetRoot);
    default:
      return false;
  }
}

export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const complete = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const failures: string[] = [];
  function visit(node: string): void {
    if (active.has(node)) {
      failures.push(`循环导入：${[...path.slice(path.indexOf(node)), node].join(' → ')}`);
      return;
    }
    if (complete.has(node)) return;
    active.add(node);
    path.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    path.pop();
    active.delete(node);
    complete.add(node);
  }
  for (const node of graph.keys()) visit(node);
  return failures;
}
