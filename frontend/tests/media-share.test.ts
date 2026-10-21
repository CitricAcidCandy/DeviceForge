import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaShareUrl, parseMediaShare, resolveMediaShareControl } from '../src/pages/devices/screen/media-share.ts';

test('分享链接严格解析设备与控制权', () => {
  assert.deepEqual(parseMediaShare('#devices?share_device=emulator-5554&share_control=1'), {
    deviceId: 'emulator-5554', control: true,
  });
  assert.deepEqual(parseMediaShare('#/devices?share_device=ABC_01&share_control=0'), {
    deviceId: 'ABC_01', control: false,
  });
  // 画面已并入设备页，旧 #media 链接与缺控制权参数的链接都不再解析。
  assert.equal(parseMediaShare('#media?share_device=emulator-5554&share_control=1'), null);
  assert.equal(parseMediaShare('#devices?share_device=bad%20id&share_control=1'), null);
  assert.equal(parseMediaShare('#devices?share_device=emulator-5554&share_control=2'), null);
  assert.equal(parseMediaShare('#devices?share_device=emulator-5554'), null);
});

test('只读分享链接不能在再次分享时升级控制权', () => {
  assert.equal(resolveMediaShareControl(true, false), false);
  assert.equal(resolveMediaShareControl(false, false), false);
  assert.equal(resolveMediaShareControl(true, true), true);
  assert.equal(resolveMediaShareControl(true, null), true);
});
