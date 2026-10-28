import { useMemo } from 'react';
import { buildProfileFlamegraph, PROFILE_FLAMEGRAPH_LIMITS } from '../../../../features/android-profile/index.ts';
import { flamePercent, layoutFlamegraph } from '../ProfileFlamegraph/layout.ts';
import type { BoardSample } from './types.ts';

/** 只展示当前原采样点的栈，不把其他采样点的调用链混进当前结果。 */
export function StackSection({ sample, selected, note }: { sample: BoardSample | undefined; selected: number; note: string }) {
  const stacks = sample?.stacks ?? [];
  const layout = useMemo(() => {
    if (stacks.length === 0) return null;
    try {
      const graph = buildProfileFlamegraph(stacks, { weight: 'samples' });
      return { graph, layout: layoutFlamegraph(graph, null, PROFILE_FLAMEGRAPH_LIMITS.nodes) };
    } catch {
      return null;
    }
  }, [stacks]);
  if (!layout) return (
    <section aria-label="调用栈章节" className="flex min-h-9 shrink-0 items-center gap-5 rounded-lg border border-hairline bg-card px-5 text-[12px]">
      <h3 className="text-[13px]! leading-[22px]! font-medium! text-ink">调用栈</h3>
      <p className="text-muted-foreground">{stacks.length > 0 ? '当前栈样本无法布局' : sample?.note ?? note}</p>
      <span className="ml-auto font-mono text-muted-foreground">#{selected + 1} · {sample?.t.toFixed(2) ?? '—'} s</span>
    </section>
  );
  const levels = Math.max(1, Math.min(layout.layout.levels, 6));
  const bars = layout.layout.bars.filter((bar) => bar.level < levels);
  return (
    <section aria-label="调用栈章节" className="flex min-h-[200px] shrink-0 flex-col gap-3 rounded-[10px] border border-hairline bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[14px]! font-medium! text-ink">调用栈</h3>
        <span className="font-mono text-[12px] text-muted-foreground">#{selected + 1} · {sample?.t.toFixed(2) ?? '—'} s</span>
      </div>
      <div className="flex min-h-[120px] flex-col gap-[2px]" aria-label="当前采样点火焰图">
        {Array.from({ length: levels }, (_, level) => (
          <div key={level} className="relative min-h-5 flex-1">
            {bars.filter((bar) => bar.level === level).map((bar) => (
              <div key={bar.node.id} title={`${bar.node.label} · ${flamePercent(bar.node.weight, String(layout.graph.totalWeight))}%`}
                className="absolute inset-y-0 overflow-hidden rounded-[4px] bg-accent px-1.5 text-[12px] leading-tight text-primary"
                style={{ left: `${bar.x}%`, width: `${Math.max(bar.width, 0.4)}%` }}>
                <span className="block truncate py-px">{bar.node.label}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="text-[12px] text-muted-foreground">
        {stacks.length} 个栈样本 · {layout.layout.levels} 层{layout.layout.omitted > 0 ? ` · 省略 ${layout.layout.omitted} 个窄条` : ''}
      </p>
    </section>
  );
}
