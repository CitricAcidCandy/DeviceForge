/*
 * 投屏参数的本地存档：下次进工作台还是上次那一组，不用每次重填。
 * 只存字符串形式的数字，读的时候严格校验——坏值一律退回默认，不让 localStorage 里的脏数据进请求。
 */
export const SIZE_STORAGE_KEY = 'deviceforge.device-screen.max-size';
export const FPS_STORAGE_KEY = 'deviceforge.device-screen.max-fps';

export function readStoredNumber(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  return stored && /^\d+$/.test(stored) ? stored : fallback;
}

export function storeNumber(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, value);
}

/* 画面缩放：和参数一起存，刷新、切页面、下次进工作台都还是上次那个大小。 */
export const ZOOM_STORAGE_KEY = 'deviceforge.device-screen.zoom';

export function readStoredZoom(min: number, max: number, fallback = 1): number {
  if (typeof window === 'undefined') return fallback;
  const stored = Number(window.localStorage.getItem(ZOOM_STORAGE_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(stored * 100) / 100));
}

export function storeZoom(value: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ZOOM_STORAGE_KEY, String(value));
}
