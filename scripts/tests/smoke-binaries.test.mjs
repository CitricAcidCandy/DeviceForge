import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { smokeBinary, smokeBinaryDirectory } from '../../backend/scripts/smoke-binaries.mjs';

test('验收默认目录与显式目标目录互不混用', () => {
  assert.equal(smokeBinaryDirectory('debug', {}), resolve('backend/target/debug'));
  const selected = resolve('artifacts/current-release');
  assert.equal(
    smokeBinary('apk-server', 'release', { DEVICEFORGE_SMOKE_BINARY_DIR: selected }),
    resolve(selected, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server'),
  );
  assert.throws(() =>
    smokeBinaryDirectory('release', { DEVICEFORGE_SMOKE_BINARY_DIR: 'relative' }),
  );
  assert.throws(() => smokeBinary('../apk-server', 'release', {}));
});
