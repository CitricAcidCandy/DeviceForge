// 每个路径均为相对 src 的正斜线路径；模块内部可以导入自身。
export function allowedDependency(from, to) {
  const origin = from.split('/');
  const target = to.split('/');
  switch (origin[0]) {
    case 'app': return ['app', 'features', 'plugins', 'shared', 'plugin-sdk'].includes(target[0]);
    case 'features': return (target[0] === 'features' && origin[1] === target[1]) || ['shared', 'plugin-sdk'].includes(target[0]);
    case 'plugins': return ['plugins', 'plugin-sdk'].includes(target[0]);
    case 'plugin-sdk': return target[0] === 'plugin-sdk';
    case 'shared': return target[0] === 'shared' && (origin[1] !== 'ui' || target[1] === 'ui');
    default: return false;
  }
}

export function findCycles(graph) {
  const complete = new Set();
  const active = new Set();
  const path = [];
  const failures = [];
  function visit(node) {
    if (active.has(node)) { failures.push(`循环导入：${[...path.slice(path.indexOf(node)), node].join(' → ')}`); return; }
    if (complete.has(node)) return;
    active.add(node); path.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    path.pop(); active.delete(node); complete.add(node);
  }
  for (const node of graph.keys()) visit(node);
  return failures;
}
