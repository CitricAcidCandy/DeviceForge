import assert from 'node:assert/strict';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inside } from '../../cli/src/paths.mjs';

// CLI离线部署没有在线包视图；仅清理本轮卸载后的精确临时夹具目录。
export async function removeOfflineFixture({ temporary, pluginDirectory, id, client }) {
  assert.match(id, /^raw_npx_(android|harmony)$/);
  const temporaryRoot = await realpath(temporary);
  const root = await realpath(pluginDirectory);
  assert.ok(root !== temporaryRoot && inside(temporaryRoot, root), '本次插件根必须在临时根内');
  const path = join(root, id);
  const stat = await lstat(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(path), path, '删除目标必须是本次插件根的真实直接子目录');
  assert.ok(inside(root, path) && inside(temporaryRoot, path));
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, id, '只删除本次安装的精确离线ID');
  await assert.rejects(lstat(join(path, '.deviceforge-package.json')), { code: 'ENOENT' });
  const online = await client.json('/api/v2/plugin-packages/server');
  assert.ok(!online.some((entry) => entry.id === id), '本轮CLI部署不能冒充在线包视图');
  await client.json(`/api/v2/plugin-packages/server/${id}`, {
    method: 'DELETE',
    status: 404,
    code: 'not_found',
  });
  await rm(path, { recursive: true });
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  return {
    method: '卸载后清理本轮精确临时CLI离线目录',
    onlineManaged: false,
    onlineDeleteStatus: 404,
    temporaryCliDeploymentRemoved: true,
  };
}
