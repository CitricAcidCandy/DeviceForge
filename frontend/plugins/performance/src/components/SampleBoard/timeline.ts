export const TIMELINE_LAYOUT = Object.freeze({
  left: 224,
  right: 60,
  minWidth: 1132,
  thumbnailWidth: 90,
  thumbnailGap: 12,
});

/** 全部画面、曲线和时间轴只使用这一份时间比例。 */
export function timelineRatio(t: number, span: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(span) || span <= 0) return 0;
  return Math.max(0, Math.min(1, t / span));
}

export function nearestSampleIndex(samples: readonly { readonly t: number }[], time: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    const gap = Math.abs(sample.t - time);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  });
  return best;
}

/** 只稀疏可见画面，不改样本数组和原索引；当前点有真帧时优先保留。 */
export function visibleFrameIndices(
  samples: readonly { readonly t: number; readonly frameUrl: string | null }[],
  span: number,
  plotWidth: number,
  selected: number,
): number[] {
  const separation = TIMELINE_LAYOUT.thumbnailWidth + TIMELINE_LAYOUT.thumbnailGap;
  const position = (index: number) => timelineRatio(samples[index]?.t ?? 0, span) * plotWidth;
  const indices: number[] = [];
  if (samples[selected]?.frameUrl) indices.push(selected);
  samples.forEach((sample, index) => {
    if (!sample.frameUrl || index === selected) return;
    if (indices.every((other) => Math.abs(position(index) - position(other)) >= separation)) indices.push(index);
  });
  return indices.sort((a, b) => a - b);
}

export function timelineTicks(span: number): number[] {
  if (!Number.isFinite(span) || span <= 0) return [0];
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((candidate) => candidate >= span / 5) ?? Math.ceil(span / 5);
  const ticks: number[] = [];
  for (let value = 0; value < span - 0.001; value += step) ticks.push(value);
  ticks.push(span);
  return ticks;
}

/** 仅移动整幅共享画布，保留纵向位置；已经完整可见的选中点不触发滚动。 */
export function selectedTimelineScrollLeft(
  pointX: number,
  viewportWidth: number,
  scrollLeft: number,
  canvasWidth: number,
): number {
  if (viewportWidth <= 0) return scrollLeft;
  const halfFrame = TIMELINE_LAYOUT.thumbnailWidth / 2 + 6;
  const next = pointX - halfFrame < scrollLeft ? pointX - halfFrame
    : pointX + halfFrame > scrollLeft + viewportWidth ? pointX + halfFrame - viewportWidth : scrollLeft;
  return Math.max(0, Math.min(Math.max(0, canvasWidth - viewportWidth), next));
}

/** 缺测会断开面积分段，不能用填色跨过没有观测的时间点。 */
export function areaSegments(
  points: readonly { readonly x: number; readonly y: number | null }[],
  span: number,
  domain: readonly [number, number],
): string[] {
  const paths: string[] = [];
  let segment: string[] = [];
  let firstX = 0;
  let lastX = 0;
  const finish = () => {
    if (segment.length > 0) paths.push(`M ${firstX} 100 L ${segment.join(' L ')} L ${lastX} 100 Z`);
    segment = [];
  };
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) { finish(); continue; }
    const x = timelineRatio(point.x, span) * 1000;
    const ratio = domain[1] <= domain[0] ? 0 : Math.max(0, Math.min(1, (point.y - domain[0]) / (domain[1] - domain[0])));
    if (segment.length === 0) firstX = x;
    lastX = x;
    segment.push(`${x} ${(1 - ratio) * 100}`);
  }
  finish();
  return paths;
}
