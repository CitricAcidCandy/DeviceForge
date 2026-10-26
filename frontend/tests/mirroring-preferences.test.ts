import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FPS_STORAGE_KEY,
  SIZE_STORAGE_KEY,
  ZOOM_STORAGE_KEY,
  readStoredNumber,
  readStoredZoom,
  storeNumber,
  storeZoom,
} from '../src/pages/devices/screen/preferences.ts';
import { paintedFrameSize } from '../src/pages/devices/screen/pointer-map.ts';

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

test('画面缩放的存档往返，脏值与越界值退回默认', () => {
  Object.assign(globalThis, { window: fakeWindow });
  try {
    storeZoom(1.85);
    assert.equal(readStoredZoom(0.6, 3), 1.85);
    memory.set(ZOOM_STORAGE_KEY, '0.2');
    assert.equal(readStoredZoom(0.6, 3), 0.6);
    memory.set(ZOOM_STORAGE_KEY, '9');
    assert.equal(readStoredZoom(0.6, 3), 3);
    memory.set(ZOOM_STORAGE_KEY, 'abc');
    assert.equal(readStoredZoom(0.6, 3), 1);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

test('元素自身尺寸优先于外部读数', () => {
  const fallback = { width: 1080, height: 2400 };
  assert.deepEqual(paintedFrameSize({ videoWidth: 720, videoHeight: 1600 }, fallback), {
    width: 720,
    height: 1600,
  });
  assert.deepEqual(paintedFrameSize({ width: 1280, height: 2844 }, fallback), {
    width: 1280,
    height: 2844,
  });
  assert.deepEqual(paintedFrameSize({ videoWidth: 0, videoHeight: 0 }, fallback), fallback);
});
