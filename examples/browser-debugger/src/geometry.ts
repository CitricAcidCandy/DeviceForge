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
export function ballPosition(x: number, y: number, viewport: Viewport, snap: boolean) {
  const margin = Math.min(16, viewport.width / 20);
  return { x: snap ? (x + 24 < viewport.width / 2 ? margin : Math.max(margin, viewport.width - 48 - margin))
    : clamp(x, margin, viewport.width - 48 - margin), y: clamp(y, margin, viewport.height - 48 - margin) };
}
