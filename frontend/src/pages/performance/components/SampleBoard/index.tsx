import { useMemo } from 'react';
import {
  buildProfileFlamegraph,
  PROFILE_FLAMEGRAPH_LIMITS,
} from '../../../../features/android-profile/index.ts';
import type { StackSample } from '../../../../features/android-profile/index.ts';
import { flamePercent, layoutFlamegraph } from '../ProfileFlamegraph/layout.ts';
import { MultiTrackChart } from '../../../../components/MultiTrackChart/index.tsx';
import { chartValue, fpsDomain, fpsValue, metricDomain } from './chart-domain.ts';

/**
 * 一条轨迹上的一个采样点。五个轨迹共用同一组 x（按真实时间戳换算），
 * 归档关联沿原时间合同；实时设备截图仅按产物时间近邻关联，偏差在 frameNote 中保留。
 */
export interface BoardSample {
  readonly id: string;
  readonly t: number;
  readonly fps: number | null;
  readonly cpu: number | null;
  readonly pssKib: number | null;
  readonly rssKib: number | null;
  readonly frameUrl: string | null;
  readonly frameNote?: string;
  readonly stacks: readonly StackSample[];
  readonly note: string | null;
}

export interface SampleBoardProps {
  readonly samples: readonly BoardSample[];
  readonly span: number;
  readonly selected: number;
  readonly onSelect: (index: number) => void;
  readonly frameNote: string;
  readonly stackNote: string;
}

// 60Hz 目标下低于 50fps 记为掉帧，和设计稿的 Jank 口径一致。
const JANK_BELOW = 50;
const THUMB_RATIO = 60 / 130;

function clamp(value: number, floor: number, ceil: number): number {
  return value < floor ? floor : value > ceil ? ceil : value;
}

function ratioOf(t: number, span: number): number {
  return span <= 0 ? 0 : clamp(t / span, 0, 1);
}

function percent(value: number | null, top: number): number {
  return value == null || top <= 0 ? 0 : clamp(value / top, 0, 1);
}

// 轨道高度写死，轨道之间留 10px 缝；不再用 flexGrow 均分，避免图被越挤越扁。
const TRACK_HEIGHT = {
  frame: 176,
  axis: 44,
  fps: 168,
  cpu: 152,
  memory: 150,
  stack: 200,
} as const;

const CPU_COLOR = '#2f7fe0';
const RSS_COLOR = '#8c7bf7';

/** 轨迹行：标签槽 + 绘图区 + 当前值列；高度固定，绘图区一律吃满。 */
function Track({
  label,
  note,
  gutter,
  now,
  height,
  children,
}: {
  label: string;
  note?: string | undefined;
  /** 标签列里的逐行说明，与 now 的行一一对应。 */
  gutter?: React.ReactNode;
  now?: React.ReactNode;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full shrink-0" style={{ height }}>
      <div className="flex w-[76px] shrink-0 flex-col pt-1 pl-4">
        <span className="text-[12px] font-medium text-[color:var(--text-muted)]">{label}</span>
        {note && (
          <span className="mt-1 block text-[12px] leading-4 text-[color:var(--text-ghost)]">
            {note}
          </span>
        )}
        {gutter && (
          <div className="mt-1 flex min-h-0 flex-1 flex-col justify-around pb-1 text-[12px] leading-4 text-[color:var(--text-ghost)]">
            {gutter}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 pr-2">{children}</div>
      <div className="w-[84px] shrink-0 pr-5 pt-1 text-right font-mono text-[13px] leading-[18px] text-[color:var(--text-strong)]">
        {gutter ? (
          <div className="flex h-full flex-col justify-around pb-1">{now ?? ''}</div>
        ) : (
          (now ?? '')
        )}
      </div>
    </div>
  );
}

function Plot({
  onPick,
  children,
  label,
}: {
  onPick?: (ratio: number) => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div
      className="relative h-full w-full"
      role="group"
      aria-label={label}
      onPointerDown={
        onPick
          ? (event) => {
              const box = event.currentTarget.getBoundingClientRect();
              if (box.width <= 0) return;
              onPick(clamp((event.clientX - box.left) / box.width, 0, 1));
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

/** 画面轨：每个采样点一张图，图片中心压在它自己的时间点上，高度跟着行高走。 */
function FrameTrack({
  samples,
  span,
  selected,
  onSelect,
  note,
}: {
  samples: readonly BoardSample[];
  span: number;
  selected: number;
  onSelect: (index: number) => void;
  note: string;
}) {
  const framed = samples.filter((sample) => sample.frameUrl != null);
  if (framed.length === 0)
    return (
      <div className="flex h-full items-center">
        <p className="text-[13px] text-[color:var(--text-faint)]">{note}</p>
      </div>
    );
  return (
    <div className="h-full overflow-hidden"><Plot label="采样画面">
      {samples.map((sample, index) =>
        sample.frameUrl == null ? null : (
          <button
            key={sample.id}
            type="button"
            onClick={() => onSelect(index)}
            title={`#${index + 1} · ${sample.t.toFixed(2)} s${sample.frameNote ? ` · ${sample.frameNote}` : ''}`}
            aria-label={`采样画面 ${index + 1}，${sample.t.toFixed(2)} 秒`}
            data-current={index === selected}
            className="absolute inset-y-0 -translate-x-1/2 overflow-hidden rounded-md border-2 bg-[color:var(--surface-sunken)] transition-colors data-[current=false]:border-transparent data-[current=true]:border-[color:var(--primary)]"
            style={{ left: `${ratioOf(sample.t, span) * 100}%`, aspectRatio: `${THUMB_RATIO}` }}
          >
            <img src={sample.frameUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          </button>
        ),
      )}
    </Plot></div>
  );
}

/** 时间轴轨：刻度 + 每个采样点的小圆点 + 游标。 */
function AxisTrack({
  samples,
  span,
  selected,
  onSelect,
}: {
  samples: readonly BoardSample[];
  span: number;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const marks = useMemo(() => {
    if (span <= 0) return [];
    // 目标 4–6 个刻度：先按跨度取一个整秒步长，再逐步放大。
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((candidate) => candidate >= span / 5) ?? Math.ceil(span / 5);
    const ticks: number[] = [];
    for (let value = 0; value < span - 0.001; value += step) ticks.push(value);
    ticks.push(span);
    return ticks;
  }, [span]);
  const current = samples[selected];
  return (
    <Plot label="采样时间轴" onPick={(ratio) => onSelect(nearestIndex(samples, span, ratio))}>
      <div className="absolute inset-x-0 top-[14px] h-px bg-[color:var(--hairline)]" />
      {marks.map((value) => (
        <div
          key={`tick-${value}`}
          className="absolute top-[8px] h-[6px] w-px bg-[color:var(--hairline-strong)]"
          style={{ left: `${ratioOf(value, span) * 100}%` }}
        />
      ))}
      {marks.map((value) => (
        <span
          key={`label-${value}`}
          className="absolute top-[18px] -translate-x-1/2 font-mono text-[12px] text-[color:var(--text-ghost)]"
          style={{ left: `${ratioOf(value, span) * 100}%` }}
        >
          {Number.isInteger(value) ? value : value.toFixed(1)}s
        </span>
      ))}
      {samples.map((sample, index) => (
        <button
          key={sample.id}
          type="button"
          onClick={() => onSelect(index)}
          aria-label={`跳到 ${sample.t.toFixed(2)} 秒`}
          className="absolute top-[11px] h-[5px] w-[5px] -translate-x-1/2 rounded-full bg-[color:var(--accent-violet)] opacity-50 transition-opacity hover:opacity-100 data-[current=true]:opacity-0"
          data-current={index === selected}
          style={{ left: `${ratioOf(sample.t, span) * 100}%` }}
        />
      ))}
      {current && (
        <div
          className="pointer-events-none absolute top-[14px] -translate-x-1/2"
          style={{ left: `${ratioOf(current.t, span) * 100}%` }}
        >
          <div className="absolute bottom-0 left-1/2 h-[14px] w-[2px] -translate-x-1/2 bg-[color:var(--primary)]" />
          <div className="h-0 w-0 -translate-y-[13px] border-x-[5px] border-b-[6px] border-x-transparent border-b-[color:var(--primary)]" />
        </div>
      )}
    </Plot>
  );
}

function nearestIndexAt(samples: readonly BoardSample[], x: number): number {
  if (samples.length === 0) return 0;
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    const gap = Math.abs(sample.t - x);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  });
  return best;
}

function nearestIndex(samples: readonly BoardSample[], span: number, ratio: number): number {
  if (samples.length === 0) return 0;
  const target = ratio * span;
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    const gap = Math.abs(sample.t - target);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  });
  return best;
}

function polyline(
  points: readonly { readonly t: number; readonly value: number }[],
  span: number,
  top: number,
): string {
  return points
    .map(
      (point) =>
        `${(ratioOf(point.t, span) * 1000).toFixed(2)},${((1 - percent(point.value, top)) * 100).toFixed(2)}`,
    )
    .join(' ');
}

/** 帧率轨：使用标签列的同一量程，缺测点保留在真实时间位置。 */
function FpsTrack({
  samples,
  span,
  selected,
  onSelect,
  domain,
}: {
  samples: readonly BoardSample[];
  span: number;
  selected: number;
  onSelect: (index: number) => void;
  domain: readonly [number, number];
}) {
  const points = samples.map((sample) => ({ x: sample.t, y: fpsValue(sample.fps) }));
  const xDomain: readonly [number, number] = [0, Math.max(span, 0.001)];
  if (points.every((point) => point.y === null))
    return (
      <div className="flex h-full items-center">
        <p className="text-[13px] text-[color:var(--text-faint)]">无帧率</p>
      </div>
    );
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <MultiTrackChart
          ariaLabel="帧率曲线"
          xDomain={xDomain}
          insets={{ left: 0, right: 0 }}
          cursorX={samples[selected]?.t ?? null}
          onPickX={(x) => onSelect(nearestIndexAt(samples, x))}
          tracks={[
            {
              id: 'fps',
              domain,
              splitLine: true,
              series: [{ id: 'fps', points, warnBelow: JANK_BELOW }],
            },
          ]}
        />
      </div>
    </div>
  );
}

/** 空态：明确没有观测，不画假曲线。 */
function NoSignal({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center">
      <p className="text-[13px] text-[color:var(--text-faint)]">{text}</p>
    </div>
  );
}

/** CPU 独占一条轨：它是百分比量纲，和内存的 KiB 不能共用一个纵轴。 */
function CpuTrack({
  samples,
  span,
  cursor,
  onSelect,
}: {
  samples: readonly BoardSample[];
  span: number;
  cursor: number | null;
  onSelect: (index: number) => void;
}) {
  const points = samples.map((sample) => ({ x: sample.t, y: chartValue(sample.cpu) }));
  if (points.every((point) => point.y === null)) return <NoSignal text="无 CPU 观测" />;
  return (
    <MultiTrackChart
      ariaLabel="CPU 占用曲线"
      xDomain={[0, Math.max(span, 0.001)]}
      insets={{ left: 0, right: 0 }}
      cursorX={cursor}
      onPickX={(x) => onSelect(nearestIndexAt(samples, x))}
      tracks={[
        {
          id: 'cpu',
          domain: metricDomain(points.map((point) => point.y)),
          splitLine: true,
          series: [{ id: 'CPU', points, width: 1.5, color: CPU_COLOR }],
        },
      ]}
    />
  );
}

/** 内存独占一条轨：PSS 实线、RSS 虚线，同一 KiB 量纲共用一个纵轴。 */
function MemoryTrack({
  samples,
  span,
  cursor,
  onSelect,
}: {
  samples: readonly BoardSample[];
  span: number;
  cursor: number | null;
  onSelect: (index: number) => void;
}) {
  const pss = samples.map((sample) => ({ x: sample.t, y: chartValue(sample.pssKib) }));
  const rss = samples.map((sample) => ({ x: sample.t, y: chartValue(sample.rssKib) }));
  const merged = [...pss, ...rss].map((point) => point.y);
  if (merged.every((value) => value === null)) return <NoSignal text="无内存观测" />;
  return (
    <MultiTrackChart
      ariaLabel="内存曲线"
      xDomain={[0, Math.max(span, 0.001)]}
      insets={{ left: 0, right: 0 }}
      cursorX={cursor}
      onPickX={(x) => onSelect(nearestIndexAt(samples, x))}
      tracks={[
        {
          id: 'memory',
          domain: metricDomain(merged),
          splitLine: true,
          series: [
            { id: 'PSS', points: pss, width: 1.5 },
            { id: 'RSS', points: rss, width: 1.2, color: RSS_COLOR, dashed: true, opacity: 0.9 },
          ],
        },
      ]}
    />
  );
}

/** 调用栈轨：只渲染当前采样点归属的栈样本，不跨点混算；层级按行高均分。 */
function StackTrack({
  sample,
  note,
}: {
  sample: BoardSample | undefined;
  note: string;
}) {
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
  if (stacks.length === 0 || !layout)
    return (
      <div className="flex h-full items-center">
        <p className="text-[13px] text-[color:var(--text-faint)]">{sample?.note ?? note}</p>
      </div>
    );
  const levels = Math.max(1, Math.min(layout.layout.levels, 6));
  const bars = layout.layout.bars.filter((bar) => bar.level < levels);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-[2px]">
        {Array.from({ length: levels }, (_, level) => (
          <div key={level} className="relative min-h-0 flex-1">
            {bars
              .filter((bar) => bar.level === level)
              .map((bar) => (
                <div
                  key={bar.node.id}
                  title={`${bar.node.label} · ${flamePercent(bar.node.weight, String(layout.graph.totalWeight))}%`}
                  className="absolute inset-y-0 overflow-hidden rounded-[4px] bg-[color:var(--accent)] px-[6px] text-[12px] leading-tight text-[color:var(--primary)]"
                  style={{
                    left: `${bar.x}%`,
                    width: `${Math.max(bar.width, 0.4)}%`,
                  }}
                >
                  <span className="block truncate py-[1px]">{bar.node.label}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
      <p className="shrink-0 pt-1 text-[12px] text-[color:var(--text-ghost)]">
        {stacks.length} 个栈样本 · {layout.layout.levels} 层
        {layout.layout.omitted > 0 ? ` · 省略 ${layout.layout.omitted} 个窄条` : ''}
      </p>
    </div>
  );
}

/** 面板外壳：图表区独立滚动，底部一条读数带说明这里一共几条轨道。 */
function BoardShell({
  trackCount,
  ariaLabel,
  children,
}: {
  trackCount: number;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)]"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto p-3">{children}</div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color:var(--hairline)] px-4 py-2 text-[12px] text-[color:var(--text-ghost)]">
        <span>图表区可滚动</span>
        <span className="font-mono">{trackCount} 条轨道</span>
      </div>
    </div>
  );
}

/** 已进入会话但尚无样本时保持安静，不把六条空轨撑满工作区。 */
function BoardSkeleton() {
  return (
    <div aria-label="等待采样数据" className="flex min-h-[280px] flex-1 items-center justify-center rounded-xl border border-[color:var(--hairline)] bg-[color:var(--card)]">
      <p role="status" className="text-[14px] text-[color:var(--text-faint)]">尚无采样数据</p>
    </div>
  );
}

function gigabytes(kib: number | null): string {
  return kib === null ? '—' : `${(kib / 1024 / 1024).toFixed(2)} GB`;
}

export function SampleBoard({
  samples,
  span,
  selected,
  onSelect,
  frameNote,
  stackNote,
}: SampleBoardProps) {
  const current = samples[selected];
  const domain = fpsDomain(samples.map((sample) => sample.fps));
  const currentFps = fpsValue(current?.fps ?? null);
  const jankCount = samples.filter((sample) => {
    const value = fpsValue(sample.fps);
    return value !== null && value < JANK_BELOW;
  }).length;
  const cpu = chartValue(current?.cpu ?? null);
  const cpuDomain = metricDomain(samples.map((sample) => chartValue(sample.cpu)));
  if (samples.length === 0) return <BoardSkeleton />;
  return (
    <BoardShell trackCount={6} ariaLabel="采样数据面板">
      <Track
        label="画面"
        height={TRACK_HEIGHT.frame}
        note={samples.some((sample) => sample.frameUrl) ? `${samples.length} 点` : undefined}
        now={current ? `#${selected + 1}` : ''}
      >
        <FrameTrack
          samples={samples}
          span={span}
          selected={selected}
          onSelect={onSelect}
          note={frameNote}
        />
      </Track>
      <Track
        label="时间轴"
        height={TRACK_HEIGHT.axis}
        now={current ? `${current.t.toFixed(2)} s` : ''}
      >
        <AxisTrack samples={samples} span={span} selected={selected} onSelect={onSelect} />
      </Track>
      <Track
        label="帧率"
        height={TRACK_HEIGHT.fps}
        note={`${domain[0]}–${domain[1]}${jankCount > 0 ? ` · Jank ${jankCount}` : ''}`}
        now={currentFps === null ? '—' : `${currentFps.toFixed(1)} fps`}
      >
        <FpsTrack samples={samples} span={span} selected={selected} onSelect={onSelect} domain={domain} />
      </Track>
      <Track
        label="CPU"
        height={TRACK_HEIGHT.cpu}
        note={cpu === null ? undefined : `${cpuDomain[0].toFixed(0)}–${cpuDomain[1].toFixed(0)} %`}
        now={cpu === null ? '—' : `${cpu.toFixed(0)} %`}
      >
        <CpuTrack
          samples={samples}
          span={span}
          cursor={current?.t ?? null}
          onSelect={onSelect}
        />
      </Track>
      <Track
        label="内存"
        height={TRACK_HEIGHT.memory}
        gutter={
          <>
            <span>PSS</span>
            <span>RSS</span>
          </>
        }
        now={
          <>
            <span>{gigabytes(chartValue(current?.pssKib ?? null))}</span>
            <span className="text-[color:var(--text-muted)]">
              {gigabytes(chartValue(current?.rssKib ?? null))}
            </span>
          </>
        }
      >
        <MemoryTrack
          samples={samples}
          span={span}
          cursor={current?.t ?? null}
          onSelect={onSelect}
        />
      </Track>
      <Track label="调用栈" height={TRACK_HEIGHT.stack} note="火焰图">
        <StackTrack sample={current} note={stackNote} />
      </Track>
    </BoardShell>
  );
}
