import type { MirroringControl } from '../../../features/mirroring-streaming/index.ts';
import type { MediaClipboardShortcut } from './media-keyboard.ts';

export interface MediaClipboardState {
  readonly text: string | null;
  readonly message: string;
}

function validClipboardText(value: string): boolean {
  if (value.includes('\0') || new TextEncoder().encode(value).length > 2048) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

export function createMediaClipboardControl(options: {
  readonly active: () => boolean;
  readonly focused: () => boolean;
  readonly identity: () => string;
  readonly ownershipRevision?: () => number | null;
  readonly enqueue: (values: readonly MirroringControl[]) => void;
  readonly write: (text: string) => Promise<void>;
  readonly changed: (state: MediaClipboardState) => void;
}) {
  let identity = options.identity();
  let text: string | null = null;
  let revision = 0;
  const pendingCopies: boolean[] = [];
  let closed = false;
  let writing = Promise.resolve();

  function publish(message: string) {
    if (!closed) options.changed({ text, message });
  }
  function reset() {
    identity = options.identity();
    text = null;
    pendingCopies.length = 0;
    revision++;
    publish('');
  }
  function current() {
    if (identity !== options.identity()) reset();
    return !closed && options.active();
  }
  function copyToComputer(manual: boolean) {
    if (!current() || text === null || (!manual && !options.focused())) return;
    const admitted = identity;
    const version = revision;
    const value = text;
    writing = writing.then(async () => {
      if (!current() || identity !== admitted || revision !== version ||
        (!manual && !options.focused())) return;
      try {
        await options.write(value);
        if (current() && identity === admitted && revision === version)
          publish('设备剪贴板已同步到当前电脑');
      } catch {
        if (current() && identity === admitted && revision === version)
          publish('设备剪贴板已收到，请点击「复制到电脑」或选中文字复制');
      }
    });
    return writing;
  }
  function requestCopy(action: 'copy' | 'cut', manual: boolean): boolean {
    if (!current()) return false;
    const legacy = (options.ownershipRevision?.() ?? null) === null;
    if (legacy && pendingCopies.length >= 256) {
      publish('设备复制请求积压，请等待当前请求完成');
      return true;
    }
    if (legacy) pendingCopies.push(manual);
    try {
      options.enqueue([{ type: 'get_clipboard', copy_key: action }]);
    } catch (error) {
      if (legacy) pendingCopies.pop();
      throw error;
    }
    publish(action === 'copy' ? '正在读取设备复制内容…' : '正在读取设备剪切内容…');
    return true;
  }

  return {
    reset,
    receive(value: string, controlRevision?: number) {
      if (!current()) return;
      let manual: boolean | undefined;
      if (controlRevision === undefined) {
        if ((options.ownershipRevision?.() ?? null) !== null) return;
        manual = pendingCopies.shift();
        if (manual === undefined) return;
      } else {
        if (options.ownershipRevision?.() !== controlRevision) return;
        manual = true;
      }
      text = value;
      revision++;
      publish('设备剪贴板已更新');
      void copyToComputer(manual);
    },
    shortcut(action: MediaClipboardShortcut): boolean {
      if (action === 'paste') return false;
      return requestCopy(action, false);
    },
    copySelection: () => requestCopy('copy', true),
    paste(value: string): boolean {
      if (!current()) return false;
      if (!validClipboardText(value)) {
        publish('粘贴文本须为有效文字，且不超过 2048 字节，请分段粘贴');
        return true;
      }
      options.enqueue([{ type: 'clipboard', text: value, paste: true }]);
      publish('已发送电脑剪贴板文本到设备');
      return true;
    },
    copyToComputer: () => copyToComputer(true),
    dispose() {
      closed = true;
      text = null;
      pendingCopies.length = 0;
      revision++;
    },
  };
}
