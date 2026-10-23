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
