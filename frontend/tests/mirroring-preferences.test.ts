import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FPS_STORAGE_KEY,
  SIZE_STORAGE_KEY,
  readStoredNumber,
  storeNumber,
} from '../src/pages/devices/screen/preferences.ts';

/* 用一份内存版 localStorage 顶替浏览器环境。 */
const memory = new Map<string, string>();
const fakeWindow = {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
  },
};

test('没有 window 时退回默认值，不抛异常', () => {
  assert.equal(readStoredNumber(SIZE_STORAGE_KEY, '1280'), '1280');
  storeNumber(SIZE_STORAGE_KEY, '1440');
  assert.equal(memory.has(SIZE_STORAGE_KEY), false);
});

test('存进去的参数下次能原样读回', () => {
  Object.assign(globalThis, { window: fakeWindow });
  try {
    storeNumber(SIZE_STORAGE_KEY, '1440');
    storeNumber(FPS_STORAGE_KEY, '60');
    assert.equal(readStoredNumber(SIZE_STORAGE_KEY, '1280'), '1440');
    assert.equal(readStoredNumber(FPS_STORAGE_KEY, '30'), '60');
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

test('脏数据一律退回默认值', () => {
  Object.assign(globalThis, { window: fakeWindow });
  try {
    memory.set(SIZE_STORAGE_KEY, 'abc');
    assert.equal(readStoredNumber(SIZE_STORAGE_KEY, '1280'), '1280');
    memory.set(SIZE_STORAGE_KEY, '-1');
    assert.equal(readStoredNumber(SIZE_STORAGE_KEY, '1280'), '1280');
    memory.set(SIZE_STORAGE_KEY, '12.5');
    assert.equal(readStoredNumber(SIZE_STORAGE_KEY, '1280'), '1280');
    memory.set(SIZE_STORAGE_KEY, '');
    assert.equal(readStoredNumber(SIZE_STORAGE_KEY, '1280'), '1280');
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});
