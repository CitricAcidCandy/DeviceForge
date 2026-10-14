import type { Dispose, ThemeAccess } from '../plugin-sdk/index.ts';

export function scopedThemeAccess(
  upstream: ThemeAccess | undefined,
  current: () => void,
  signal: AbortSignal,
  track: (release: Dispose) => Dispose,
): ThemeAccess | undefined {
  if (!upstream) return undefined;
  return Object.freeze<ThemeAccess>({
    snapshot: () => {
      current();
      return upstream.snapshot();
    },
    select: (id) => {
      current();
      upstream.select(id);
    },
    subscribe: (listener) => {
      current();
      return track(
        upstream.subscribe((snapshot) => {
          if (!signal.aborted) listener(snapshot);
        }),
      );
    },
  });
}
