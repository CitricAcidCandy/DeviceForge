import { cn } from '../../utils/classnames.ts';

export type DevicePlatformTone = 'android' | 'ios' | 'harmony' | 'emulator' | 'generic';

/*
 * 平台徽标：一个字母说清平台。样式全在工具类里，尺寸只由 size 决定，
 * 离线只降饱和不换色相，避免同一台设备在两种状态看起来像两个平台。
 */
const tones: Record<DevicePlatformTone, { on: string; off: string }> = {
  android: {
    on: 'bg-platform-android-tint text-platform-android',
    off: 'bg-platform-android-idle-tint text-platform-android-idle',
  },
  ios: {
    on: 'bg-platform-ios-tint text-platform-ios',
    off: 'bg-platform-ios-tint text-platform-ios opacity-60',
  },
  harmony: {
    on: 'bg-platform-harmony-tint text-platform-harmony',
    off: 'bg-platform-harmony-tint text-platform-harmony opacity-60',
  },
  emulator: {
    on: 'bg-platform-emulator-tint text-platform-emulator',
    off: 'bg-platform-emulator-tint text-platform-emulator opacity-60',
  },
  generic: {
    on: 'bg-platform-emulator-tint text-platform-emulator',
    off: 'bg-platform-emulator-tint text-platform-emulator opacity-60',
  },
};

const sizes = {
  sm: 'size-4 rounded-[5px] text-[10px]',
  md: 'size-8 rounded-[9px] text-[12px]',
  lg: 'size-11 rounded-xl text-[15px]',
} as const;

export function DeviceBadge({
  tone,
  letter,
  size = 'md',
  idle = false,
  className,
}: {
  tone: DevicePlatformTone;
  letter: string;
  size?: keyof typeof sizes;
  idle?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-mono font-bold leading-none',
        sizes[size],
        idle ? tones[tone].off : tones[tone].on,
        className,
      )}
    >
      {letter}
    </span>
  );
}
