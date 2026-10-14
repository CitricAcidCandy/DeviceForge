import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { decodeStackJsonLines, buildProfileFlamegraph } from '../src/features/android-profile/index.ts';
import { ProfileFlamegraphView } from '../src/features/android-profile/ui/index.ts';
import type { FlameInterval } from '../src/features/android-profile/ui/index.ts';

// 验收入口只消费已取得的离线原栈，不连接设备或自动派发业务。
export function mountFlamegraphReview(target: HTMLElement | null, jsonl: string, intervals: readonly FlameInterval[] = []) {
  if (!target) throw new Error('火焰图验收挂载点不存在');
  const stacks = decodeStackJsonLines(new TextEncoder().encode(jsonl));
  const graph = buildProfileFlamegraph(stacks);
  const root = createRoot(target);
  root.render(createElement(ProfileFlamegraphView, { stacks, intervals }));
  return { summary: { sampleCount: graph.selectedSampleCount, totalWeight: graph.totalWeight, nodes: graph.nodes.length, quality: graph.quality }, dispose: () => root.unmount() };
}
