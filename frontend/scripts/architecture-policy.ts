// 每个路径均为相对 src 的正斜线路径；测试夹具可直接访问内部实现。
const featureLayers = new Set(['domain', 'application', 'infrastructure', 'ui']);
const componentLayers = new Set(['ui', 'common', 'integrations', 'lib']);
const sourceFile = /\.(?:ts|tsx|js|mjs|cjs)$/;

function publicFeatureEntry(parts: readonly string[]): boolean {
  return parts.length === 3 && parts[0] === 'features' && /^index\.tsx?$/.test(parts[2] ?? '');
}
function pureShared(parts: readonly string[]): boolean {
  return parts[0] === 'shared' && (parts[1] === 'lib' || parts[1] === 'utils');
}
// 校验源码位置，不强制模块建立没有用途的空层目录。
export function sourcePlacementIssue(file: string): string | null {
  const parts = file.split('/');
  if (parts[0] !== 'features' || !sourceFile.test(file)) return null;
  if (publicFeatureEntry(parts)) return null;
  if (parts.length < 4 || !featureLayers.has(parts[2] ?? '')) return '功能源码必须位于 domain/application/infrastructure/ui，根目录仅保留 index 公开入口';
  return null;
}
function componentDependency(origin: readonly string[], target: readonly string[]): boolean {
  if (pureShared(target)) return true;
  if (target[0] !== 'components') return false;
  const from = origin[1] ?? ''; const to = target[1] ?? '';
  if (!componentLayers.has(from) || !componentLayers.has(to)) return false;
  if (from === 'lib') return to === 'lib';
  if (from === 'ui') return to === 'ui' || to === 'lib';
  if (from === 'common') return ['common', 'ui', 'lib'].includes(to);
  return ['integrations', 'common', 'ui', 'lib'].includes(to);
}
function featureDependency(origin: readonly string[], target: readonly string[]): boolean {
  const from = origin[2] ?? '';
  if (target[0] === 'components') return from === 'ui';
  if (target[0] !== 'features') return ['shared', 'plugin-sdk'].includes(target[0] ?? '');
  if (origin[1] !== target[1]) return false;
  if (publicFeatureEntry(origin)) return publicFeatureEntry(target) || featureLayers.has(target[2] ?? '');
  const to = target[2] ?? '';
  if (!featureLayers.has(from) || !featureLayers.has(to)) return false;
  if (from === 'domain') return to === 'domain';
  if (from === 'infrastructure') return to === 'domain' || to === 'infrastructure';
  if (from === 'application') return ['domain', 'infrastructure', 'application'].includes(to);
  return true;
}
export function allowedDependency(from: string, to: string): boolean {
  const origin = from.split('/'); const target = to.split('/');
  const targetLayer = target[0] ?? '';
  switch (origin[0]) {
    case 'app': return targetLayer === 'features' ? publicFeatureEntry(target) : ['app', 'components', 'plugins', 'shared', 'plugin-sdk'].includes(targetLayer);
    case 'features': return featureDependency(origin, target);
    case 'components': return componentDependency(origin, target);
    case 'plugins': return ['plugins', 'plugin-sdk'].includes(targetLayer);
    case 'plugin-sdk': return targetLayer === 'plugin-sdk';
    case 'shared': return pureShared(origin) ? pureShared(target) : targetLayer === 'shared' && (origin[1] !== 'ui' || target[1] === 'ui');
    case 'tests': return ['app', 'features', 'components', 'plugins', 'shared', 'plugin-sdk'].includes(targetLayer);
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
