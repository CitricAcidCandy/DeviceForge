import { useCallback, useEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createMediaKeyboardControl } from './media-keyboard.ts';
import type { MediaClipboardShortcut } from './media-keyboard.ts';
import type { MirroringControl } from '../../../features/mirroring-streaming/index.ts';

interface MediaKeyboardOptions {
  readonly active: boolean;
  readonly ready: boolean;
  readonly identity: string;
  readonly enqueue: (values: readonly MirroringControl[]) => void;
  readonly clipboardShortcut?: (action: MediaClipboardShortcut) => boolean;
}

export function useMediaKeyboard(options: MediaKeyboardOptions) {
  const current = useRef(options);
  const controller = useRef<ReturnType<typeof createMediaKeyboardControl> | null>(null);
  const surface = useRef<HTMLCanvasElement | HTMLVideoElement | null>(null);
  const previousIdentity = useRef(options.identity);
  const [focused, setFocused] = useState(false);
  current.current = options;

  useEffect(() => {
    if (!options.active) {
      controller.current?.release();
      controller.current?.reset();
      controller.current = null;
      setFocused(false);
      return;
    }
    const keyboard = createMediaKeyboardControl({
      ready: () => current.current.active && current.current.ready,
      identity: () => current.current.identity,
      enqueue: (values) => current.current.enqueue(values),
      ...(options.clipboardShortcut ? {
        clipboardShortcut: (action: MediaClipboardShortcut) => current.current.clipboardShortcut?.(action) ?? false,
      } : {}),
    });
    controller.current = keyboard;
    const release = () => keyboard.release();
    const hidden = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', hidden);
      keyboard.release();
      keyboard.reset();
      if (controller.current === keyboard) controller.current = null;
      setFocused(false);
    };
  }, [options.active]);

  useEffect(() => {
    if (previousIdentity.current === options.identity) return;
    controller.current?.reset();
    previousIdentity.current = options.identity;
    surface.current?.blur();
    surface.current = null;
    setFocused(false);
  }, [options.identity]);

  useEffect(() => {
    if (!options.ready) {
      controller.current?.release();
      setFocused(false);
    } else if (options.active && surface.current && document.activeElement === surface.current)
      setFocused(true);
  }, [options.ready]);

  const keyDown = useCallback((event: ReactKeyboardEvent<HTMLCanvasElement | HTMLVideoElement>) => {
    const handled = controller.current?.keyDown(event.nativeEvent) ?? false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const keyUp = useCallback((event: ReactKeyboardEvent<HTMLCanvasElement | HTMLVideoElement>) => {
    const handled = controller.current?.keyUp(event.nativeEvent) ?? false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const focus = useCallback((event: ReactFocusEvent<HTMLCanvasElement | HTMLVideoElement>) => {
    surface.current = event.currentTarget;
    if (current.current.active && current.current.ready) setFocused(true);
  }, []);

  const blur = useCallback(() => {
    setFocused(false);
    controller.current?.release();
  }, []);

  return {
    focused,
    tabIndex: options.active && options.ready ? 0 : -1,
    onKeyDown: keyDown,
    onKeyUp: keyUp,
    onFocus: focus,
    onBlur: blur,
  };
}
