import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { assertNoOwnedResources, readIfExists } from './fixtures.mjs';

// 只归档本轮已退出媒体的标记，不删除远端模拟资源；恢复仍必须由插件完成。
export async function archiveCleanSession(fixture, device, { requireClean = true } = {}) {
  assert.ok([fixture.device, fixture.nextDevice].includes(device));
  if (requireClean) await assertNoOwnedResources(fixture, device);
  const root = resolve(fixture.plan(device));
  const archive = resolve(root, 'history-' + randomUUID());
  assert.ok(root.startsWith(resolve(fixture.root) + sep) && archive.startsWith(root + sep));
  await mkdir(archive);
  for (const name of ['epoch-1', 'remote-cleaned', 'forward-removed']) {
    const source = join(root, name), target = join(archive, name);
    assert.ok(resolve(source).startsWith(root + sep) && resolve(target).startsWith(archive + sep));
    if (name === 'epoch-1' || await readIfExists(source)) {
      try { await rename(source, target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
