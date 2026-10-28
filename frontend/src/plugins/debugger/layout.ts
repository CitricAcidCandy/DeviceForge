import type { EvidenceState, LayoutRect, UiLayout } from './contracts.ts';

function rectangle(x: number, y: number, width: number, height: number): LayoutRect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x };
}
function measure(element: Element): LayoutRect | null {
  if (!element.isConnected || element.getClientRects().length === 0) return null;
  const value = element.getBoundingClientRect();
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width < 0 || value.height < 0) return null;
  return rectangle(value.x, value.y, value.width, value.height);
}
function intersection(a: LayoutRect, b: LayoutRect, x = true, y = true): LayoutRect {
  const left = x ? Math.max(a.left, b.left) : a.left;
  const top = y ? Math.max(a.top, b.top) : a.top;
  const right = x ? Math.min(a.right, b.right) : a.right;
  const bottom = y ? Math.min(a.bottom, b.bottom) : a.bottom;
  return rectangle(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
function contains(a: LayoutRect, b: LayoutRect): boolean {
  return b.left >= a.left && b.top >= a.top && b.right <= a.right && b.bottom <= a.bottom;
}
export function measureLayout(element: Element, root: Element): UiLayout {
  const unavailable = (reason: string): UiLayout => ({ source: 'unavailable', rect: null, viewport: null,
    region: null, intersection: null, nonzeroSize: 'unknown', inViewport: 'unknown', withinRoot: 'unknown',
    clipped: 'unknown', occluded: 'unknown', reason });
  const view = element.ownerDocument.defaultView;
  if (!view) return unavailable('目标窗口不可用');
  try {
    const rect = measure(element);
    if (!rect) return unavailable('没有客户端布局矩形；无布局引擎或display:none不能测量');
    const visual = view.visualViewport;
    const width = visual?.width ?? view.innerWidth, height = visual?.height ?? view.innerHeight;
    const viewport = [width, height].every(Number.isFinite) && width > 0 && height > 0
      ? rectangle(visual?.offsetLeft ?? 0, visual?.offsetTop ?? 0, width, height) : null;
    const region = measure(root);
    let visible = viewport ? intersection(rect, viewport) : rect;
    let unsupported = false, knownClip = viewport !== null && !contains(viewport, rect);
    // 滚动容器按客户端内框裁切；变换、复杂遮罩和多片段布局不作可靠裁切结论。
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = view.getComputedStyle(ancestor);
      if ((style.transform && style.transform !== 'none') || (style.clipPath && style.clipPath !== 'none') ||
          (style.maskImage && style.maskImage !== 'none') || (style.clip && style.clip !== 'auto') ||
          /paint|strict|content/.test(style.contain) || ancestor.getClientRects().length > 1) unsupported = true;
      if (ancestor === element) continue;
      const clips = (axis: string) => ['hidden', 'clip', 'scroll', 'auto'].includes(axis || style.overflow);
      const clipX = clips(style.overflowX), clipY = clips(style.overflowY);
      if (!clipX && !clipY) continue;
      if ([style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
        .some((radius) => radius && !/^0(?:px|%)?(?:\s+0(?:px|%)?)?$/.test(radius))) unsupported = true;
      const outer = measure(ancestor);
      if (!outer) { unsupported = true; continue; }
      const client = rectangle(outer.x + ancestor.clientLeft, outer.y + ancestor.clientTop, ancestor.clientWidth, ancestor.clientHeight);
      const next = intersection(visible, client, clipX, clipY);
      if (next.width < visible.width || next.height < visible.height) knownClip = true;
      visible = next;
    }
    const state = (value: boolean): EvidenceState => value ? 'yes' : 'no';
    return { source: 'client-rects', rect, viewport, region, intersection: unsupported ? null : visible,
      nonzeroSize: state(rect.width > 0 && rect.height > 0),
      inViewport: viewport ? state(contains(viewport, rect)) : 'unknown',
      withinRoot: region ? state(contains(region, rect)) : 'unknown',
      clipped: unsupported || !viewport ? 'unknown' : state(knownClip), occluded: 'unknown',
      reason: unsupported ? '复杂裁切或变换无法可靠裁定；遮挡未知' : 'CSS视口坐标和轴向裁切证据；遮挡未知' };
  } catch { return unavailable('客户端布局测量失败'); }
}
