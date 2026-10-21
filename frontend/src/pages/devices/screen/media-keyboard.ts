import type { MirroringControl } from '../../../features/mirroring-streaming/index.ts';

export interface MediaKeyboardEvent {
  readonly code: string;
  readonly key: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode?: number;
  readonly getModifierState: (key: string) => boolean;
}

export type MediaClipboardShortcut = 'copy' | 'cut' | 'paste';

interface PressedKey {
  readonly identity: string;
  readonly keycode: number;
  readonly modifierState: number;
  repeat: number;
}

const KEY_CODES: Readonly<Record<string, number>> = {
  Backquote: 68,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
  Comma: 55,
  Period: 56,
  Space: 62,
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 4,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  ShiftLeft: 59,
  ShiftRight: 60,
  ControlLeft: 113,
  ControlRight: 114,
  AltLeft: 57,
  AltRight: 58,
  MetaLeft: 117,
  MetaRight: 118,
};

const MODIFIER_STATES: Readonly<Record<string, number>> = {
  ShiftLeft: 1 | 0x40,
  ShiftRight: 1 | 0x80,
  ControlLeft: 4096 | 0x2000,
  ControlRight: 4096 | 0x4000,
  AltLeft: 2 | 0x10,
  AltRight: 2 | 0x20,
  MetaLeft: 0x10000 | 0x20000,
  MetaRight: 0x10000 | 0x40000,
};

const BROWSER_SHORTCUT_CODES = new Set([
  'KeyA', 'KeyB', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyL', 'KeyN',
  'KeyO', 'KeyP', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyW', 'KeyY', 'KeyZ',
  'Digit0', 'Digit1', 'Minus', 'Equal',
]);

function codeFor(event: MediaKeyboardEvent): number | null {
  const direct = KEY_CODES[event.code];
  if (direct !== undefined) return direct;
  if (event.code.startsWith('Key') && event.code.length === 4) {
    const value = event.code.charCodeAt(3) - 65;
    if (value >= 0 && value < 26) return 29 + value;
  }
  if (event.code.startsWith('Digit') && event.code.length === 6) {
    const digit = event.code.charCodeAt(5) - 48;
    if (digit >= 0 && digit <= 9) return digit === 0 ? 7 : 7 + digit;
  }
  if (event.code.startsWith('Numpad') && event.code.length === 7) {
    const digit = event.code.charCodeAt(6) - 48;
    if (digit >= 0 && digit <= 9) return digit === 0 ? 7 : 7 + digit;
  }
  if (event.key.length === 1) {
    const value = event.key.toUpperCase();
    if (/^[A-Z]$/.test(value)) return 29 + value.charCodeAt(0) - 65;
    if (value >= '0' && value <= '9') {
      const digit = value.charCodeAt(0) - 48;
      return digit === 0 ? 7 : 7 + digit;
    }
  }
  if (event.key === ' ') return 62;
  if (event.key === 'Esc') return 4;
  return null;
}

function modifier(event: MediaKeyboardEvent, name: string): boolean {
  return event.getModifierState(name);
}

function metaState(event: MediaKeyboardEvent): number {
  let state = 0;
  const shift = event.shiftKey || modifier(event, 'Shift');
  const alt = event.altKey || modifier(event, 'Alt');
  const control = event.ctrlKey || modifier(event, 'Control');
  const meta = event.metaKey || modifier(event, 'Meta');
  if (shift) state |= 1;
  if (alt) state |= 2;
  if (control) state |= 4096;
  if (meta) state |= 0x10000;
  if (modifier(event, 'CapsLock')) state |= 0x100000;
  if (modifier(event, 'NumLock')) state |= 0x200000;
  if (modifier(event, 'ScrollLock')) state |= 0x400000;
  return state;
}

function keyIdentity(event: MediaKeyboardEvent): string {
  return event.code || `key:${event.key}`;
}

export function createMediaKeyboardControl(options: {
  readonly ready: () => boolean;
  readonly identity: () => string;
  readonly enqueue: (values: readonly MirroringControl[]) => void;
  readonly clipboardShortcut?: (action: MediaClipboardShortcut) => boolean;
}) {
  const pressed = new Map<string, PressedKey>();
  let currentIdentity = options.identity();
  let lockState = 0;

  function syncIdentity(): boolean {
    const next = options.identity();
    if (next === currentIdentity) return true;
    pressed.clear();
    lockState = 0;
    currentIdentity = next;
    return false;
  }

  function release(): void {
    if (!syncIdentity() || pressed.size === 0) return;
    const values: MirroringControl[] = [];
    const entries = [...pressed.values()].reverse();
    for (const entry of entries) {
      pressed.delete(entry.identity);
      values.push({
        type: 'key', action: 'up', keycode: entry.keycode,
        meta_state: entriesMetaState(),
      });
    }
    options.enqueue(values);
  }

  function reset(): void {
    pressed.clear();
    lockState = 0;
    currentIdentity = options.identity();
  }

  function keyDown(event: MediaKeyboardEvent): boolean {
    syncIdentity();
    if (!options.ready()) return false;
    if (event.isComposing || event.keyCode === 229 ||
      event.key === 'Dead' || event.key === 'Process' || event.key === 'Unidentified') {
      release();
      return false;
    }
    const primaryModifier = event.ctrlKey || event.metaKey || modifier(event, 'Control') || modifier(event, 'Meta');
    const clipboardAction = primaryModifier && !event.altKey
      ? event.code === 'KeyC' ? 'copy' : event.code === 'KeyX' ? 'cut' : event.code === 'KeyV' ? 'paste' : null
      : null;
    if (clipboardAction) {
      release();
      if (event.repeat) return true;
      return options.clipboardShortcut?.(clipboardAction) ?? false;
    }
    const shortcut = primaryModifier && BROWSER_SHORTCUT_CODES.has(event.code);
    const altModifier = event.altKey || modifier(event, 'Alt');
    const systemKey = event.code === 'Tab' || event.key === 'Tab' ||
      (altModifier && MODIFIER_STATES[event.code] === undefined) ||
      event.code === 'F5' || event.code === 'F11';
    if (shortcut || systemKey) {
      release();
      return false;
    }
    const keycode = codeFor(event);
    if (keycode === null) return false;
    const identity = keyIdentity(event);
    const previous = pressed.get(identity);
    if (event.repeat && !previous) return false;
    const repeat = Math.min(1000, previous ? previous.repeat + 1 : 0);
    lockState = metaState(event) & 0x700000;
    pressed.set(identity, {
      identity, keycode, modifierState: MODIFIER_STATES[event.code] ?? 0, repeat,
    });
    options.enqueue([{
      type: 'key', action: 'down', keycode, repeat,
      meta_state: metaState(event) | entriesMetaState(),
    }]);
    return true;
  }

  function keyUp(event: MediaKeyboardEvent): boolean {
    if (!syncIdentity()) return false;
    if (event.isComposing || event.keyCode === 229 ||
      event.key === 'Dead' || event.key === 'Process' || event.key === 'Unidentified') {
      release();
      return false;
    }
    const identity = keyIdentity(event);
    const entry = pressed.get(identity);
    if (!entry) return false;
    pressed.delete(identity);
    lockState = metaState(event) & 0x700000;
    options.enqueue([{
      type: 'key', action: 'up', keycode: entry.keycode,
      meta_state: metaState(event) | entriesMetaState(),
    }]);
    return true;
  }

  function entriesMetaState(): number {
    let state = lockState;
    for (const entry of pressed.values()) state |= entry.modifierState;
    return state;
  }

  return { keyDown, keyUp, release, reset };
}
