import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAdvancedMirroringSettings } from '../src/pages/devices/screen/advanced-settings.ts';
import {
  ADVANCED_MIRRORING_STORAGE_KEY,
  readAdvancedMirroringSettings,
  storeAdvancedMirroringSettings,
} from '../src/pages/devices/screen/advanced-preferences.ts';

function withStorage(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }, run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  try { run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('投屏高级偏好：往返保留非法草稿和独立开关，不把存档校验当成参数提交', () => {
  const values = new Map<string, string>();
  withStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  }, () => {
    assert.deepEqual(readAdvancedMirroringSettings(), defaultAdvancedMirroringSettings());
    const draft = { videoBitRateMbps: '24', audio: true, clipboardAutosync: false, reconnectAttempts: '3' };
    storeAdvancedMirroringSettings(draft);
    assert.deepEqual(readAdvancedMirroringSettings(), draft);
    assert.equal(values.size, 1);
    assert.ok(values.has(ADVANCED_MIRRORING_STORAGE_KEY));
  });
});

test('投屏高级偏好：未知或损坏存档逐字段回落，不把字符串强制当成开关', () => {
  let stored = '{损坏';
  withStorage({ getItem: () => stored, setItem() {} }, () => {
    assert.deepEqual(readAdvancedMirroringSettings(), defaultAdvancedMirroringSettings());
    stored = JSON.stringify({ videoBitRateMbps: '8.000001', audio: 'true', clipboardAutosync: false, reconnectAttempts: 3 });
    assert.deepEqual(readAdvancedMirroringSettings(), {
      videoBitRateMbps: '8.000001', audio: false, clipboardAutosync: false, reconnectAttempts: '0',
    });
    stored = ' '.repeat(1025);
    assert.deepEqual(readAdvancedMirroringSettings(), defaultAdvancedMirroringSettings());
    stored = '[]';
    assert.deepEqual(readAdvancedMirroringSettings(), defaultAdvancedMirroringSettings());
  });
});

test('投屏高级偏好：存储拒绝不阻止当前草稿，超限写入不覆盖原存档', () => {
  withStorage({ getItem() { throw new Error('拒绝读取'); }, setItem() { throw new Error('配额不足'); } }, () => {
    assert.deepEqual(readAdvancedMirroringSettings(), defaultAdvancedMirroringSettings());
    assert.doesNotThrow(() => storeAdvancedMirroringSettings(defaultAdvancedMirroringSettings()));
  });
  let writes = 0;
  withStorage({ getItem: () => null, setItem() { writes += 1; } }, () => {
    storeAdvancedMirroringSettings({ ...defaultAdvancedMirroringSettings(), reconnectAttempts: '1'.repeat(2048) });
    assert.equal(writes, 0);
  });
});
