import type { ProfileFlamegraph, ProfileFlameNode, ProfileFlameLayoutNode } from '../domain/flamegraph.ts';

export interface FlameBar { readonly node: ProfileFlameLayoutNode; readonly x: number; readonly width: number; readonly level: number }
export interface FlameLayout { readonly bars: readonly FlameBar[]; readonly levels: number; readonly omitted: number; readonly focus: ProfileFlameLayoutNode | null }
// 先做整数比例，再转换有界坐标；大事件计数也不损失聚合精度。
function ratio(part: bigint, total: bigint): number {
  return total === 0n ? 0 : Number(part * 1_000_000n / total) / 1000;
}
export function layoutFlamegraph(graph: ProfileFlamegraph, focusId: number | null, maximum = 4000): FlameLayout {
  const focus = graph.nodes.find(node => node.id === focusId) ?? null;
  const allowed = new Set<number>();
  if (focus) {
    const pending: ProfileFlameNode[] = [focus];
    while (pending.length) {
      const node = pending.pop();
      if (!node) break;
      allowed.add(node.id); pending.push(...node.children);
    }
  }
  const origin = BigInt(focus?.startWeight ?? '0');
  const total = BigInt(focus?.weight ?? graph.totalWeight);
  const depth = focus?.depth ?? 0;
  const bars: FlameBar[] = [];
  let omitted = 0; let levels = 1;
  for (const node of graph.nodes) {
    if (focus && !allowed.has(node.id)) continue;
    const width = ratio(BigInt(node.weight), total);
    if (BigInt(node.weight) === 0n) continue;
    const level = node.depth - depth;
    levels = Math.max(levels, level + 1);
    if (width < 0.4 || bars.length >= maximum) { omitted += 1; continue; }
    bars.push({ node, x: ratio(BigInt(node.startWeight) - origin, total), width, level });
  }
  return { bars, levels, omitted, focus };
}
export function flamePercent(value: string, total: string): string {
  const denominator = BigInt(total);
  return denominator === 0n ? '0.00' : (Number(BigInt(value) * 10000n / denominator) / 100).toFixed(2);
}
export function flameColor(node: ProfileFlameLayoutNode): string {
  let hash = 0;
  for (const character of node.key) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return node.kind === 'frame' ? 'hsl(' + (18 + hash % 32) + ' 77% ' + (62 + hash % 15) + '%)' : 'hsl(213 25% ' + (75 - node.depth * 6) + '%)';
}
