import assert from 'node:assert/strict';
import test from 'node:test';
import { devicePoint } from '../src/pages/devices/screen/pointer-map.ts';

/*
 * 点击换算的护栏：画面在容器里等比居中，元素矩形包含留白带；
 * 换算必须落回设备像素，并在放大缩小后仍然对得上。
 */

test('无留白时四角与中心一一对应', () => {
  const size = { width: 1080, height: 2400 };
  const rect = { left: 100, top: 50, width: 540, height: 1200 };
  assert.deepEqual(devicePoint(rect, size, 100, 50), { x: 0, y: 0 });
  assert.deepEqual(devicePoint(rect, size, 640, 1250), { x: 1079, y: 2399 });
  assert.deepEqual(devicePoint(rect, size, 370, 650), { x: 540, y: 1200 });
});

test('视频等比居中留白时，按真正被画面占满的矩形换算', () => {
  const size = { width: 1080, height: 2400 };
  // 画面框 266×582 内放 1080×2400（0.45）的视频：上下铺满，左右各留 2.05px。
  const rect = { left: 509, top: 108, width: 266, height: 582 };
  const scale = Math.min(rect.width / size.width, rect.height / size.height);
  const bar = (rect.width - size.width * scale) / 2;
  assert.equal(devicePoint(rect, size, rect.left + bar, rect.top + rect.height / 2).x, 0);
  assert.equal(devicePoint(rect, size, rect.left + rect.width - bar, rect.top + rect.height / 2).x, 1079);
  assert.equal(devicePoint(rect, size, rect.left + rect.width / 2, rect.top + rect.height / 2).y, 1200);
  // 点在留白带里：夹到设备边缘，不产生负坐标。
  assert.deepEqual(devicePoint(rect, size, rect.left + 0.5, rect.top), { x: 0, y: 0 });
});

test('画面放大两倍后同一处点击仍落在同一设备点', () => {
  const size = { width: 1080, height: 2400 };
  const base = { left: 300, top: 60, width: 266, height: 582 };
  const zoomed = { left: 240, top: 40, width: 532, height: 1164 };
  const at = { x: 0.25, y: 0.75 };
  const fromBase = devicePoint(base, size, base.left + base.width * at.x, base.top + base.height * at.y);
  const fromZoom = devicePoint(zoomed, size, zoomed.left + zoomed.width * at.x, zoomed.top + zoomed.height * at.y);
  assert.deepEqual(fromBase, fromZoom);
  assert.deepEqual(fromBase, { x: 266, y: 1800 });
});

test('横屏画面按宽度受限换算', () => {
  const size = { width: 2400, height: 1080 };
  const rect = { left: 0, top: 100, width: 800, height: 500 };
  // 800/2400 = 0.333，500/1080 = 0.463 → 宽度受限，画面高 360，上下各留 70。
  assert.equal(devicePoint(rect, size, 0, 100 + 70).y, 0);
  assert.equal(devicePoint(rect, size, 800, 100 + 430).y, 1079);
  assert.equal(devicePoint(rect, size, 400, 100 + 250).x, 1200);
});
