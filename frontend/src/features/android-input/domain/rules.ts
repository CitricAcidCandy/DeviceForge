import { HostError } from '../../../plugin-sdk/index.ts';
import type { DeviceAction, DeviceSnapshot } from '../../../plugin-sdk/index.ts';
import type { AndroidUnicodeInput } from './types.ts';

const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new HostError('protocol', 'invalid_android_input', message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function hasControl(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

export function normalizeAndroidInput(value: unknown): AndroidUnicodeInput & { readonly bytes: number; readonly unicode: boolean } {
  if (!record(value)) return invalid('Android 输入必须是对象');
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'text' || key === 'enter') || !Object.hasOwn(value, 'text') || typeof value.text !== 'string') {
    return invalid('Android 输入字段无效');
  }
  if (Object.hasOwn(value, 'enter') && typeof value.enter !== 'boolean') return invalid('Android 回车字段必须为布尔值');
  const text = value.text;
  if (!text || !validUnicode(text) || hasControl(text)) return invalid('Android 文本必须为非空且不含控制字符的 Unicode');
  const bytes = encoder.encode(text).byteLength;
  const unicode = Array.from(text).some((character) => character.codePointAt(0)! > 0x7f);
  const limit = unicode ? 4096 : 1024;
  if (bytes > limit) return invalid(`Android 文本 UTF-8 字节数不得超过 ${limit}`);
  const enter = typeof value.enter === 'boolean' ? value.enter : undefined;
  return Object.freeze({ text, ...(enter === undefined ? {} : { enter }), bytes, unicode });
}

export function androidInputAction(snapshot: DeviceSnapshot, input: AndroidUnicodeInput): DeviceAction {
  const selected = snapshot.selection;
  if (!selected || !snapshot.selected) throw new HostError('protocol', 'android_input_device_not_selected', '请先选择在线设备');
  if (snapshot.selected.state !== 'online') throw new HostError('protocol', 'android_input_device_unavailable', '设备当前不可用');
  const capability = snapshot.selected.capabilities.find((entry) => entry.id === 'input' && entry.version === 1);
  if (!capability?.available) throw new HostError('protocol', 'android_input_unavailable', capability?.reason ?? '设备不支持输入能力');
  const action = Object.freeze({ kind: 'text', text: input.text, ...(input.enter === undefined ? {} : { enter: input.enter }) });
  return Object.freeze({ providerId: selected.providerId, generation: selected.generation, deviceId: selected.localId,
    capability: 'input', version: 1, input: Object.freeze({ action }) });
}
