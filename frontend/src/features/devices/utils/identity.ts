// 设备身份的呈现映射：平台 → 徽标字母与色调，状态 → 文案。
// 选择设备页、顶栏胶囊、下拉弹窗共用这一份，避免三处各写一套中文与配色。

export const deviceStateLabels = {
  online: '在线',
  offline: '离线',
  unauthorized: '等待设备授权',
  unknown: '状态未知',
} as const;

// 胶囊与弹窗里字号小、列宽窄，状态用短标签；整句留给详情栏。
export const deviceStateShort = {
  online: '在线',
  offline: '离线',
  unauthorized: '待授权',
  unknown: '未知',
} as const;

export type DeviceStateKey = keyof typeof deviceStateLabels;

export function deviceStateLabel(state: string): string {
  return deviceStateLabels[state as DeviceStateKey] ?? state;
}

export function deviceStateCaption(state: string): string {
  return deviceStateShort[state as DeviceStateKey] ?? state;
}

export type PlatformTone = 'android' | 'ios' | 'harmony' | 'emulator' | 'generic';

const platformTones: readonly [PlatformTone, readonly string[]][] = [
  ['android', ['android']],
  ['ios', ['ios', 'iphone', 'ipad', 'apple']],
  ['harmony', ['harmony', 'ohos', 'hongmeng']],
  ['emulator', ['emulator', 'simulator']],
];

export function devicePlatformTone(platform: string): PlatformTone {
  const key = platform.trim().toLocaleLowerCase();
  const matched = platformTones.find(([, needles]) => needles.some((needle) => key.includes(needle)));
  return matched ? matched[0] : 'generic';
}

// 徽标只放一个字母：四类平台固定，其余取平台名首字母。
export function devicePlatformLetter(platform: string): string {
  switch (devicePlatformTone(platform)) {
    case 'android':
      return 'A';
    case 'ios':
      return 'i';
    case 'harmony':
      return 'H';
    case 'emulator':
      return 'E';
    default:
      return platform.trim().slice(0, 1).toLocaleUpperCase() || '?';
  }
}

const platformLabels: Record<PlatformTone, string> = {
  android: 'Android',
  ios: 'iOS',
  harmony: '鸿蒙',
  emulator: '模拟器',
  generic: '',
};

export function devicePlatformLabel(platform: string): string {
  return platformLabels[devicePlatformTone(platform)] || platform.trim() || '未知平台';
}

// 设备状态 → 只用于取色的档位，CSS 里由 [data-state] 决定实色。
export function deviceStateTone(state: string): string {
  return state === 'online' || state === 'offline' || state === 'unauthorized' ? state : 'unknown';
}
