import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from 'node:path';
import { apkSample, storedZip } from '../android-packages-smoke/samples.mjs';
import { localId } from './fixtures.mjs';

export const apksHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const comparablePath = (path) => toNamespacedPath(resolve(path));

// 独立外层与内层ZIP；只满足本批结构合同，不模拟真实设备匹配数据。
export function apksSample() {
  return storedZip([['toc.pb', Buffer.from([8, 1])], ['splits/base-master.apk', apkSample('android-device-apks')]]);
}

export function apksArgv(fixture, argv, deviceId = localId) {
  assert.equal(argv.length, 7, 'AD-APKS-ARGV-COUNT');
  assert.deepEqual([argv[0], argv[1], argv[3]], ['-Xmx256m', '-jar', 'install-apks']);
  assert.ok(isAbsolute(argv[2])); assert.equal(comparablePath(argv[2]), comparablePath(fixture.bundletoolJar));
  assert.ok(argv[4].startsWith('--apks='));
  const path = argv[4].slice('--apks='.length);
  assert.ok(isAbsolute(path)); assert.equal(basename(path), 'input.apks');
  assert.ok(comparablePath(dirname(path)).startsWith(comparablePath(fixture.scratchRoot) + sep));
  assert.equal(argv[5], '--device-id=' + deviceId);
  assert.ok(argv[6].startsWith('--adb=')); assert.ok(isAbsolute(argv[6].slice('--adb='.length)));
  return path;
}

export async function apksCopy(fixture, item, bytes, { deviceId = localId, live = false } = {}) {
  const input = apksArgv(fixture, item.ready.argv, deviceId), root = dirname(input);
  assert.equal(item.ready.tool_kind, 'java');
  assert.equal(await realpath(item.ready.argv[6].slice('--adb='.length)), await realpath(fixture.copiedTool));
  for (const field of ['cwd', 'temp', 'tmp', 'tmpdir']) {
    assert.ok(isAbsolute(item.ready[field])); assert.equal(comparablePath(item.ready[field]), comparablePath(root), 'AD-APKS-PRIVATE-' + field);
  }
  const retained = await readFile(join(item.directory, 'install-input.bin'));
  assert.deepEqual(retained, bytes, 'AD-APKS-COPY');
  if (live) assert.deepEqual(await readFile(input), bytes);
  else await assert.rejects(lstat(root), { code: 'ENOENT' });
  item.private_copy = { size: retained.length, sha256: apksHash(retained), original_bytes_equal: true, deleted_after: !live };
  item.java_private_context = { cwd_and_three_temp_equal: true, absolute_adb_resolved: true,
    boundary: '假Java入口实际观测cwd和环境，不证明真实JVM内部临时文件或bundletool派生ADB树' };
}
