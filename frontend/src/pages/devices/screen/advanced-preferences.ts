import { defaultAdvancedMirroringSettings } from './advanced-settings.ts';
import type { AdvancedMirroringDraft } from './advanced-settings.ts';

export const ADVANCED_MIRRORING_STORAGE_KEY = 'deviceforge.device-screen.advanced.v1';

export function readAdvancedMirroringSettings(): AdvancedMirroringDraft {
  const fallback = defaultAdvancedMirroringSettings();
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(ADVANCED_MIRRORING_STORAGE_KEY);
    if (!stored || stored.length > 1024) return fallback;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    return {
      videoBitRateMbps: 'videoBitRateMbps' in value && typeof value.videoBitRateMbps === 'string' &&
        value.videoBitRateMbps.length <= 64 ? value.videoBitRateMbps : fallback.videoBitRateMbps,
      audio: 'audio' in value && typeof value.audio === 'boolean' ? value.audio : fallback.audio,
      clipboardAutosync: 'clipboardAutosync' in value && typeof value.clipboardAutosync === 'boolean'
        ? value.clipboardAutosync : fallback.clipboardAutosync,
      reconnectAttempts: 'reconnectAttempts' in value && typeof value.reconnectAttempts === 'string' &&
        value.reconnectAttempts.length <= 32 ? value.reconnectAttempts : fallback.reconnectAttempts,
    };
  } catch {
    return fallback;
  }
}

export function storeAdvancedMirroringSettings(draft: AdvancedMirroringDraft): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = JSON.stringify(draft);
    if (stored.length > 1024) return;
    window.localStorage.setItem(ADVANCED_MIRRORING_STORAGE_KEY, stored);
  } catch {
    // 无痕模式、配额或存储拒绝只影响下次进入，不阻止当前编辑和显式开始。
  }
}
