import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chartValue, fpsDomain, fpsValue, metricDomain,
} from '../src/pages/performance/components/SampleBoard/chart-domain.ts';

test('帧率量程包含零帧和低帧，不再固定从 30 起画', () => {
  assert.deepEqual(fpsDomain([0]), [0, 30]);
  assert.deepEqual(fpsDomain([0, 1, 12, 29]), [0, 30]);
  assert.deepEqual(fpsDomain([31, 41.5, 59]), [0, 60]);
  assert.equal(fpsValue(0), 0);
  assert.equal(fpsValue(12.5), 12.5);
});

test('常见高帧率与超过 240 的真实峰值均不被裁切', () => {
  const cases = [
    { peak: 77, top: 90 }, { peak: 120, top: 120 }, { peak: 120.1, top: 144 },
    { peak: 144, top: 144 }, { peak: 165, top: 165 }, { peak: 240, top: 240 },
    { peak: 241, top: 360 }, { peak: 480, top: 480 }, { peak: 500, top: 500 },
    { peak: 937, top: 950 },
  ];
  for (const { peak, top } of cases) {
    assert.deepEqual(fpsDomain([null, 0, 12, peak]), [0, top]);
    assert.equal(fpsValue(peak), peak, '量程变化不能改写真实数据');
  }
});

test('缺测和非法帧率保留为 null，不变成零或影响量程', () => {
  const readings = [0, null, Number.NaN, 77, Number.POSITIVE_INFINITY, -1, 12];
  assert.deepEqual(readings.map(fpsValue), [0, null, null, 77, null, null, 12]);
  assert.deepEqual(fpsDomain(readings), [0, 90]);
  assert.deepEqual(fpsDomain([]), [0, 30]);
  assert.deepEqual(fpsDomain([null, Number.NaN, -1]), [0, 30]);
  assert.equal(readings[1], null, '规则不回写原采样');
  assert.ok(Number.isNaN(readings[2]));
});

test('极大但有限的帧率仍得到有限且覆盖峰值的量程', () => {
  for (const peak of [1_000, 10_001, Number.MAX_VALUE]) {
    const [floor, ceiling] = fpsDomain([peak]);
    assert.equal(floor, 0);
    assert.ok(Number.isFinite(ceiling));
    assert.ok(ceiling >= peak);
  }
});

test('性能三轨独立量程忽略缺测但保留零值和实际数值', () => {
  assert.deepEqual(metricDomain([null, 0, 23, Number.NaN]), [0, 23]);
  assert.deepEqual(metricDomain([null, 409_600, 471_040]), [0, 471_040]);
  assert.deepEqual(metricDomain([null, Number.POSITIVE_INFINITY]), [0, 1]);
  assert.deepEqual(metricDomain([-4, 0, 8]), [-4, 8]);
  assert.equal(chartValue(null), null);
  assert.equal(chartValue(0), 0);
  assert.equal(chartValue(23.5), 23.5);
  assert.equal(chartValue(Number.NEGATIVE_INFINITY), null);
});
