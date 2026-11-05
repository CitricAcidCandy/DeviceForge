import type { DeviceProviderInfo } from '@deviceforge/plugin-sdk';
export { deviceIdentity as deviceKey, sameDevice } from './contracts.ts';

export type PlatformTone = 'android' | 'ios' | 'harmony' | 'emulator' | 'generic';
const platforms: Readonly<Record<string, { readonly label: string; readonly letter: string; readonly tone: PlatformTone }>> = {
  android: { label: 'Android', letter: 'A', tone: 'android' },
  ios: { label: 'iOS', letter: 'i', tone: 'ios' },
  harmony: { label: 'Harmony', letter: 'H', tone: 'harmony' },
  emulator: { label: '模拟器', letter: 'E', tone: 'emulator' },
};
// 平台只决定展示，不参与发现、连接或能力派发。
export const devicePlatformLabel = (platform: string): string => platforms[platform]?.label ?? (platform || '未知平台');
export const devicePlatformLetter = (platform: string): string => platforms[platform]?.letter ?? (platform[0]?.toLocaleUpperCase() || '?');
export const devicePlatformTone = (platform: string): PlatformTone => platforms[platform]?.tone ?? 'generic';
export const providerKey = (provider: Pick<DeviceProviderInfo, 'id' | 'generation'>): string => JSON.stringify([provider.id, provider.generation]);
const stateLabels: Readonly<Record<string, string>> = { online: '在线', offline: '离线', unauthorized: '待授权', unknown: '状态未知' };
export const deviceStateCaption = (state: string): string => stateLabels[state] ?? '状态未知';
export const deviceStateLabel = deviceStateCaption;
export const deviceStateTone = (state: string): string => state in stateLabels ? state : 'unknown';
