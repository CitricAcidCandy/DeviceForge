import { hostUi } from '@deviceforge/plugin-sdk';
import type { PlatformTone } from './directory-display.ts';

const tones: Record<PlatformTone, { readonly on: string; readonly off: string }> = {
  android: { on: 'bg-platform-android-tint text-platform-android', off: 'bg-platform-android-idle-tint text-platform-android-idle' },
  ios: { on: 'bg-platform-ios-tint text-platform-ios', off: 'bg-platform-ios-tint text-platform-ios opacity-60' },
  harmony: { on: 'bg-platform-harmony-tint text-platform-harmony', off: 'bg-platform-harmony-tint text-platform-harmony opacity-60' },
  emulator: { on: 'bg-platform-emulator-tint text-platform-emulator', off: 'bg-platform-emulator-tint text-platform-emulator opacity-60' },
  generic: { on: 'bg-platform-emulator-tint text-platform-emulator', off: 'bg-platform-emulator-tint text-platform-emulator opacity-60' },
};
export function DeviceBadge({ tone, letter, size = 'md', idle = false }: {
  readonly tone: PlatformTone; readonly letter: string; readonly size?: 'md' | 'lg'; readonly idle?: boolean;
}) {
  return <span aria-hidden="true" className={hostUi().cn(
    'inline-flex shrink-0 items-center justify-center font-mono font-bold leading-none',
    size === 'lg' ? 'size-11 rounded-xl text-[15px]' : 'size-8 rounded-[9px] text-[12px]',
    idle ? tones[tone].off : tones[tone].on,
  )}>{letter}</span>;
}
