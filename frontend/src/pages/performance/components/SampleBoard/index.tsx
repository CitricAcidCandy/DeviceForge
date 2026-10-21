import { useMemo } from 'react';
import {
  buildProfileFlamegraph,
  PROFILE_FLAMEGRAPH_LIMITS,
} from '../../../../features/android-profile/index.ts';
import type { StackSample } from '../../../../features/android-profile/index.ts';
import { flamePercent, layoutFlamegraph } from '../ProfileFlamegraph/layout.ts';

/**
 * 一条轨迹上的一个采样点。五个轨迹共用同一组 x（按真实时间戳换算），
 * 所以「第 n 个采样点」在画面、帧率、性能、栈上是同一刻。
 */
export interface BoardSample {
  readonly id: string;
  readonly t: number;
  readonly fps: number | null;
  readonly cpu: number | null;
  readonly pssKib: number | null;
  readonly rssKib: number | null;
  readonly frameUrl: string | null;
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

const FPS_FLOOR = 30;
const FPS_CEIL = 60;
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

/** 轨迹行：标签槽 + 绘图区 + 当前值列；高度按 flexGrow 分配，绘图区一律吃满。 */
function Track({
  label,
  note,
  now,
  grow,
  fixed,
  last,
  children,
}: {
  label: string;
  note?: string | undefined;
  now?: React.ReactNode;
  grow?: number;
  fixed?: number;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        'flex min-h-0 w-full' + (last ? '' : ' border-b border-[color:var(--hairline)]')
      }
      style={
        fixed === undefined
          ? { flexGrow: grow ?? 1, flexBasis: 0 }
          : { flexGrow: 0, flexShrink: 0, flexBasis: fixed }
      }
    >
      <div className="w-[76px] shrink-0 py-3 pl-4">
        <span className="text-[11px] font-medium text-[color:var(--text-muted)]">{label}</span>
        {note && (
          <span className="mt-1 block text-[11px] leading-4 text-[color:var(--text-ghost)]">
            {note}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 py-2 pr-2">{children}</div>
      <div className="w-[84px] shrink-0 py-3 pr-5 text-right font-mono text-[12px] leading-[18px] text-[color:var(--text-strong)]">
        {now ?? ''}
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
        <p className="text-[12px] text-[color:var(--text-faint)]">{note}</p>
      </div>
    );
  return (
    <Plot label="采样画面">
      {samples.map((sample, index) =>
        sample.frameUrl == null ? null : (
          <button
            key={sample.id}
            type="button"
            onClick={() => onSelect(index)}
            title={`#${index + 1} · ${sample.t.toFixed(2)} s`}
            aria-label={`采样画面 ${index + 1}，${sample.t.toFixed(2)} 秒`}
            data-current={index === selected}
            className="absolute inset-y-0 -translate-x-1/2 overflow-hidden rounded-md border-2 bg-[color:var(--surface-sunken)] transition-colors data-[current=false]:border-transparent data-[current=true]:border-[color:var(--primary)]"
            style={{ left: `${ratioOf(sample.t, span) * 100}%`, aspectRatio: `${THUMB_RATIO}` }}
          >
            <img src={sample.frameUrl} alt="" className="h-full w-full object-cover" />
          </button>
        ),
      )}
    </Plot>
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
          className="absolute top-[18px] -translate-x-1/2 font-mono text-[11px] text-[color:var(--text-ghost)]"
          style={{ left: `${ratioOf(value, span) * 100}%` }}
        >
          {Math.round(value)}s
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

/** 帧率轨：折线只连真实采样点，不做插值；高度按行高拉伸，点位用百分比。 */
function FpsTrack({
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
  const points = samples.flatMap((sample) =>
    sample.fps == null ? [] : [{ t: sample.t, value: sample.fps }],
  );
  const jank = points.filter((point) => point.value < JANK_BELOW).length;
  const level = (value: number) => (1 - percent(value, FPS_CEIL)) * 100;
  if (points.length === 0)
    return (
      <div className="flex h-full items-center">
        <p className="text-[12px] text-[color:var(--text-faint)]">无帧率</p>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="flex w-[54px] shrink-0 flex-col justify-between py-1 text-[11px] text-[color:var(--text-ghost)]">
        <span className="font-mono">{FPS_CEIL}</span>
        {jank > 0 && <span className="font-mono text-[color:var(--warning)]">Jank {jank}</span>}
        <span className="font-mono">{FPS_FLOOR}</span>
      </div>
      <div className="min-w-0 flex-1">
        <Plot
          label="帧率曲线"
          onPick={(ratio) => onSelect(nearestIndex(samples, span, ratio))}
        >
          {[FPS_CEIL, (FPS_CEIL + FPS_FLOOR) / 2, FPS_FLOOR].map((value) => (
            <div
              key={value}
              className="absolute inset-x-0 h-px bg-[color:var(--hairline)]"
              style={{ top: `${(1 - percent(value, FPS_CEIL)) * 100}%` }}
            />
          ))}
          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              points={polyline(points, span, FPS_CEIL)}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
          {points.length <= 120 &&
            points.map((point, index) => (
              <span
                key={index}
                className={
                  'pointer-events-none absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full ' +
                  (point.value < JANK_BELOW
                    ? 'bg-[color:var(--warning)]'
                    : 'bg-[color:var(--primary)]')
                }
                style={{ left: `${ratioOf(point.t, span) * 100}%`, top: `${level(point.value)}%` }}
              />
            ))}
          {samples[selected] && (
            <div
              className="pointer-events-none absolute inset-y-0 w-px border-l border-dashed border-[color:var(--primary)]"
              style={{ left: `${ratioOf(samples[selected].t, span) * 100}%` }}
            />
          )}
        </Plot>
      </div>
    </div>
  );
}

interface MetricRow {
  readonly label: string;
  readonly value: number | null;
  readonly text: (value: number) => string;
  readonly points: readonly { readonly t: number; readonly value: number }[];
}

/** 三条进程级细轨共用同一组 x，与上面的时间轴严格对齐。 */
function metricRows(samples: readonly BoardSample[], selected: number): readonly MetricRow[] {
  return [
    {
      label: 'CPU %',
      value: samples[selected]?.cpu ?? null,
      text: (value: number) => `${value.toFixed(0)} %`,
      points: samples.flatMap((sample) => (sample.cpu == null ? [] : [{ t: sample.t, value: sample.cpu }])),
    },
    {
      label: '内存 PSS',
      value: samples[selected]?.pssKib ?? null,
      text: (value: number) => `${(value / 1024 / 1024).toFixed(2)} GB`,
      points: samples.flatMap((sample) =>
        sample.pssKib == null ? [] : [{ t: sample.t, value: sample.pssKib }],
      ),
    },
    {
      label: '内存 RSS',
      value: samples[selected]?.rssKib ?? null,
      text: (value: number) => `${(value / 1024 / 1024).toFixed(2)} GB`,
      points: samples.flatMap((sample) =>
        sample.rssKib == null ? [] : [{ t: sample.t, value: sample.rssKib }],
      ),
    },
  ];
}

function PerfTrack({
  rows,
  samples,
  span,
  cursor,
  onSelect,
}: {
  rows: readonly MetricRow[];
  samples: readonly BoardSample[];
  span: number;
  cursor: number | null;
  onSelect: (index: number) => void;
}) {
  if (rows.every((row) => row.points.length === 0))
    return (
      <div className="flex h-full items-center">
        <p className="text-[12px] text-[color:var(--text-faint)]">无指标</p>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col justify-between">
      {rows.map((row) => {
        const top = Math.max(...row.points.map((point) => point.value), 1);
        const floor = Math.min(...row.points.map((point) => point.value), 0);
        const level = (value: number) =>
          floor === top ? 50 : (1 - (value - floor) / (top - floor)) * 100;
        return (
          <div
            key={row.label}
            className="flex min-h-0 flex-1 items-center gap-3 border-t border-[color:var(--hairline)]/60 first:border-t-0"
          >
            <span className="w-[54px] shrink-0 text-[11px] text-[color:var(--text-muted)]">
              {row.label}
            </span>
            <div className="h-full min-w-0 flex-1 py-[3px]">
              <Plot
                label={`${row.label} 曲线`}
                onPick={(ratio) => onSelect(nearestIndex(samples, span, ratio))}
              >
                {row.points.length > 1 && (
                  <svg
                    className="absolute inset-0 h-full w-full overflow-visible"
                    viewBox="0 0 1000 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points={row.points
                        .map(
                          (point) =>
                            `${(ratioOf(point.t, span) * 1000).toFixed(2)},${(floor === top ? 50 : (1 - (point.value - floor) / (top - floor)) * 100).toFixed(2)}`,
                        )
                        .join(' ')}
                      fill="none"
                      stroke="var(--primary)"
                      strokeOpacity={0.55}
                      strokeWidth={1.2}
                      vectorEffect="non-scaling-stroke"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {row.points.length <= 120 &&
                  row.points.map((point, index) => (
                    <span
                      key={index}
                      className="pointer-events-none absolute h-[4px] w-[4px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--primary)] opacity-70"
                      style={{ left: `${ratioOf(point.t, span) * 100}%`, top: `${level(point.value)}%` }}
                    />
                  ))}
                {cursor != null && (
                  <div
                    className="pointer-events-none absolute inset-y-0 w-px bg-[color:var(--accent)]"
                    style={{ left: `${ratioOf(cursor, span) * 100}%` }}
                  />
                )}
              </Plot>
            </div>
          </div>
        );
      })}
    </div>
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
        <p className="text-[12px] text-[color:var(--text-faint)]">{sample?.note ?? note}</p>
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
                  className="absolute inset-y-0 overflow-hidden rounded-[4px] bg-[color:var(--accent)] px-[6px] text-[11px] leading-tight text-[color:var(--primary)]"
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
      <p className="shrink-0 pt-1 text-[11px] text-[color:var(--text-ghost)]">
        {stacks.length} 个栈样本 · {layout.layout.levels} 层
        {layout.layout.omitted > 0 ? ` · 省略 ${layout.layout.omitted} 个窄条` : ''}
      </p>
    </div>
  );
}

/** 还没有采样点时用骨架占位：行结构、行高与真实轨迹一致，避免空得难看。 */
function Shimmer({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={'animate-pulse rounded-[3px] bg-[color:var(--surface-sunken)] ' + (className ?? '')}
      style={style}
    />
  );
}

const SKELETON_WAVE = [
  46, 58, 50, 66, 54, 42, 34, 52, 62, 56, 48, 64, 68, 54, 44, 40, 56, 60, 50, 58, 66, 52, 42, 54,
];

function BoardSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)]"
      aria-busy="true"
      aria-label="等待采样数据"
    >
      <Track label="画面" grow={3} now={<Shimmer className="ml-auto mt-1 h-[10px] w-[24px]" />}>
        <div className="flex h-full items-stretch gap-2.5">
          {Array.from({ length: 14 }, (_, index) => (
            <div
              key={index}
              className="flex-1 animate-pulse rounded-[5px] bg-[color:var(--surface-sunken)]"
              style={{ opacity: 0.45 + (index % 3) * 0.2 }}
            />
          ))}
        </div>
      </Track>
      <Track label="时间轴" fixed={44}>
        <div className="flex h-full flex-col justify-end gap-2 pb-2">
          <div className="flex items-end justify-between">
            {Array.from({ length: 13 }, (_, index) => (
              <div key={index} className="h-[6px] w-px bg-[color:var(--hairline)]" />
            ))}
          </div>
          <div className="h-px w-full bg-[color:var(--hairline)]" />
        </div>
      </Track>
      <Track label="帧率" grow={3}>
        <div className="flex h-full items-end gap-1">
          {SKELETON_WAVE.map((height, index) => (
            <div
              key={index}
              className="flex-1 animate-pulse rounded-[2px] bg-[color:var(--surface-sunken)]"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </Track>
      <Track label="性能数据" grow={2}>
        <div className="flex h-full flex-col justify-around">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Shimmer className="h-[8px] w-[52px]" />
              <Shimmer className="h-[2px] flex-1" />
              <Shimmer className="h-[8px] w-[40px]" />
            </div>
          ))}
        </div>
      </Track>
      <Track label="调用栈" note="火焰图" grow={4} last>
        <div className="flex h-full flex-col gap-[5px]">
          {[100, 76, 58, 41, 26].map((width) => (
            <Shimmer key={width} className="min-h-[12px] flex-1" style={{ width: `${width}%` }} />
          ))}
        </div>
      </Track>
    </div>
  );
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
  const rows = metricRows(samples, selected);
  if (samples.length === 0) return <BoardSkeleton />;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)]">
      <Track
        label="画面"
        note={samples.some((sample) => sample.frameUrl) ? `${samples.length} 点` : undefined}
        now={current ? `#${selected + 1}` : ''}
        grow={3}
      >
        <FrameTrack
          samples={samples}
          span={span}
          selected={selected}
          onSelect={onSelect}
          note={frameNote}
        />
      </Track>
      <Track label="时间轴" now={current ? `${current.t.toFixed(2)} s` : ''} fixed={44}>
        <AxisTrack samples={samples} span={span} selected={selected} onSelect={onSelect} />
      </Track>
      <Track
        label="帧率"
        now={current?.fps == null ? '' : `${current.fps.toFixed(1)} fps`}
        grow={3}
      >
        <FpsTrack samples={samples} span={span} selected={selected} onSelect={onSelect} />
      </Track>
      <Track
        label="性能数据"
        grow={2}
        now={
          rows.every((row) => row.points.length === 0) ? null : (
            <div className="flex h-full flex-col justify-around">
              {rows.map((row) => (
                <div key={row.label} className="flex items-center justify-end">
                  {row.value == null ? '—' : row.text(row.value)}
                </div>
              ))}
            </div>
          )
        }
      >
        <PerfTrack
          rows={rows}
          samples={samples}
          span={span}
          cursor={current?.t ?? null}
          onSelect={onSelect}
        />
      </Track>
      <Track
        label="调用栈"
        note="火焰图"
        grow={4}
        last
      >
        <StackTrack sample={current} note={stackNote} />
      </Track>
    </div>
  );
}
