import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import type { MirroringClipboard, MirroringControl } from '../../features/mirroring-streaming/index.ts';
import { createMediaClipboardControl } from './media-clipboard.ts';
import type { MediaClipboardState } from './media-clipboard.ts';
import type { MediaClipboardShortcut } from './media-keyboard.ts';

function copyWithSelection(text: string): void {
  const previous = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const target = document.createElement('textarea');
  target.value = text;
  target.setAttribute('aria-hidden', 'true');
  target.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;';
  document.body.append(target);
  try {
    target.select();
    if (!document.execCommand('copy')) throw new Error('浏览器未允许写入剪贴板');
  } finally {
    target.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  copyWithSelection(text);
}

export function useMediaClipboard(options: {
  readonly active: boolean;
  readonly ready: boolean;
  readonly identity: string;
  readonly clipboard: MirroringClipboard | null;
  readonly ownershipRevision?: number | null;
  readonly focused: () => boolean;
  readonly enqueue: (values: readonly MirroringControl[]) => void;
}) {
  const current = useRef(options);
  current.current = options;
  const [state, setState] = useState<MediaClipboardState>({ text: null, message: '' });
  const controller = useRef<ReturnType<typeof createMediaClipboardControl> | null>(null);
  useEffect(() => {
    if (!options.active) return;
    const clipboard = createMediaClipboardControl({
      active: () => current.current.active && current.current.ready,
      focused: () => current.current.focused() && document.visibilityState !== 'hidden',
      identity: () => current.current.identity,
      ownershipRevision: () => current.current.ownershipRevision ?? null,
      enqueue: (values) => current.current.enqueue(values),
      write: writeClipboard,
      changed: setState,
    });
    controller.current = clipboard;
    return () => {
      clipboard.dispose();
      if (controller.current === clipboard) controller.current = null;
      setState({ text: null, message: '' });
    };
  }, [options.active]);
  useEffect(() => { controller.current?.reset(); }, [options.identity, options.ready, options.ownershipRevision]);
  useEffect(() => {
    if (options.clipboard && options.ready)
      controller.current?.receive(options.clipboard.text, options.clipboard.controlRevision);
  }, [options.clipboard, options.ready]);
  const shortcut = useCallback((action: MediaClipboardShortcut) => controller.current?.shortcut(action) ?? false, []);
  const paste = useCallback((event: ReactClipboardEvent<HTMLCanvasElement | HTMLVideoElement>) => {
    if (!Array.from(event.clipboardData.types).includes('text/plain')) return;
    if (controller.current?.paste(event.clipboardData.getData('text/plain'))) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);
  return {
    ...state,
    shortcut,
    onPaste: paste,
    copySelection: () => controller.current?.copySelection(),
    copyToComputer: () => controller.current?.copyToComputer(),
  };
}
