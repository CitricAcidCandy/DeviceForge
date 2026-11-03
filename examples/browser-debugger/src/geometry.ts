export interface Viewport { readonly width: number; readonly height: number }
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
export function fit(rect: Rect, viewport: Viewport): Rect {
  const margin = Math.min(16, viewport.width / 20, viewport.height / 20);
  const width = clamp(rect.width, Math.min(640, viewport.width - margin * 2), viewport.width - margin * 2);
  const height = clamp(rect.height, Math.min(420, viewport.height - margin * 2), viewport.height - margin * 2);
  return { width, height, x: clamp(rect.x, margin, viewport.width - margin - width),
    y: clamp(rect.y, margin, viewport.height - margin - height) };
}
export function initialRect(viewport: Viewport): Rect {
  return fit({ x: viewport.width >= 1280 ? (viewport.width - 1200) / 2 : 16,
    y: viewport.width >= 1280 ? 48 : 40, width: viewport.width >= 1280 ? 1200 : viewport.width - 32,
    height: viewport.width >= 1280 ? 704 : 688 }, viewport);
}
export function snapPanel(rect: Rect, viewport: Viewport): Rect {
  const fitted = fit(rect, viewport);
  const margin = Math.min(16, viewport.width / 20, viewport.height / 20);
  const right = viewport.width - fitted.x - fitted.width;
  const bottom = viewport.height - fitted.y - fitted.height;
  return { ...fitted,
    x: fitted.x <= 24 && fitted.x <= right ? margin
      : right <= 24 ? viewport.width - margin - fitted.width : fitted.x,
    y: fitted.y <= 24 && fitted.y <= bottom ? margin
      : bottom <= 24 ? viewport.height - margin - fitted.height : fitted.y };
}
export function resizeByKey(rect: Rect, key: string, shift: boolean, viewport: Viewport): Rect {
  const step = shift ? 32 : 8;
  return fit({ ...rect, width: rect.width + (key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0),
    height: rect.height + (key === 'ArrowDown' ? step : key === 'ArrowUp' ? -step : 0) }, viewport);
}
export function ballPosition(x: number, y: number, viewport: Viewport, snap: boolean, obstacles: readonly Rect[] = []) {
  const margin = Math.min(16, viewport.width / 20);
  // 停靠和拖动共用底部留白，避免悬浮入口覆盖平台状态与日志。
  const bottomMargin = Math.max(margin, Math.min(40, viewport.height / 5));
  const position = { x: snap ? (x + 24 < viewport.width / 2 ? margin : Math.max(margin, viewport.width - 48 - margin))
    : clamp(x, margin, viewport.width - 48 - margin), y: clamp(y, margin, viewport.height - 48 - bottomMargin) };
  const blocked = obstacles.filter((rect) => Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0
    && rect.x < position.x + 56 && rect.x + rect.width + 8 > position.x)
    .map((rect) => ({ start: rect.y - 56, end: rect.y + rect.height + 8 }))
    .sort((left, right) => left.start - right.start);
  const intervals: { start: number; end: number }[] = [];
  for (const interval of blocked) {
    const previous = intervals.at(-1);
    if (previous && interval.start < previous.end) previous.end = Math.max(previous.end, interval.end);
    else intervals.push({ ...interval });
  }
  const conflict = intervals.find((interval) => position.y > interval.start && position.y < interval.end);
  if (!conflict) return position;
  // 同一停靠边内找最近安全边界；空间不足时保留可拖动入口，不反复跳边。
  const candidates = [conflict.start, conflict.end].filter((candidate) => candidate >= margin
    && candidate <= viewport.height - 48 - bottomMargin)
    .sort((left, right) => Math.abs(left - position.y) - Math.abs(right - position.y) || left - right);
  return candidates[0] === undefined ? position : { ...position, y: candidates[0] };
}
