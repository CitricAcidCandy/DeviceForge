import type { Rect } from './geometry.ts';

const ownSurface = '[data-deviceforge-debugger]';
const controls = 'button,input:not([type="hidden"]),select,textarea,a[href],summary,[role="button"],[role="tab"],'
  + '[role="checkbox"],[role="switch"],[role="combobox"],[contenteditable="true"]';
const readings = 'p,h1,h2,h3,h4,h5,h6,[role="heading"],dt,dd,label,output,th,td,pre';

export function readBallObstacles(document: Document, x: number): readonly Rect[] {
  const view = document.defaultView;
  if (!view) return [];
  const obstacles: Rect[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(`${controls},${readings}`)) {
    if (element.closest(`${ownSurface},[hidden],[inert],[aria-hidden="true"]`)) continue;
    // 折叠结果仍可能保留布局读数，不把未展开的正文误作可见障碍。
    if (element.matches('pre') && element.closest('details:not([open])')) continue;
    // 正文与标题同样需要留出阅读位置，空文本不挤占可停靠空间。
    if (!element.matches(controls) && !element.textContent?.trim()) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right + 8 <= x || rect.left >= x + 56
      || rect.bottom <= 0 || rect.top >= view.innerHeight) continue;
    const style = view.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') continue;
    obstacles.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }
  return obstacles;
}

export function watchBallObstacles(document: Document, onChange: () => void): () => void {
  const view = document.defaultView;
  if (!view) return () => {};
  let frame: number | null = null, closed = false;
  const schedule = () => {
    if (closed || frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; if (!closed) onChange(); });
  };
  const observer = new view.MutationObserver((records) => {
    if (records.some((record) => {
      const element = record.target instanceof view.Element ? record.target : record.target.parentElement;
      return !element?.closest(ownSurface);
    })) schedule();
  });
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-state', 'open'] });
  document.addEventListener('scroll', schedule, true);
  view.addEventListener('resize', schedule);
  schedule();
  return () => {
    if (closed) return;
    closed = true;
    observer.disconnect();
    document.removeEventListener('scroll', schedule, true);
    view.removeEventListener('resize', schedule);
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
  };
}
