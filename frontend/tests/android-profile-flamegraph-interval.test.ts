import assert from 'node:assert/strict';
import test from 'node:test';
import { closedFlameInterval } from '../src/features/android-profile/flamegraph-interval.ts';
test('指标闭区间转换为火焰半开区间，包含末端和单点', () => {
  assert.deepEqual(closedFlameInterval('指标', '4', '7'), { label: '指标', beginNs: '4', endNs: '8' });
  assert.equal(closedFlameInterval('单点', '9007199254740993', '9007199254740993').endNs, '9007199254740994');
});
test('u64最大指标末端不溢出，使用空上界', () => {
  assert.equal(closedFlameInterval('末端', '18446744073709551615', '18446744073709551615').endNs, '');
});
