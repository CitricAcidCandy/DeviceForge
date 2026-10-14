import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export async function retainTheme(directory, report) {
  const within = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(
    within &&
      !isAbsolute(within) &&
      within !== '..' &&
      !within.startsWith('../') &&
      !within.startsWith('..\\'),
    '只能保留本次临时根',
  );
  report.temporary_retained = directory;
  report.temporary_removed = false;
  report.retained_files = [];
  report.retained_file_errors = [];
  report.retained_index_scope =
    '业务数据、日志和上传原包逐字节索引；本次浏览器缓存目录原件保留，不计入业务原件摘要';
  let count = 0;
  const visit = async (folder, depth) => {
    assert.ok(depth <= 8, '主题业务原件目录深度超限');
    for (const item of await readdir(folder, { withFileTypes: true })) {
      assert.ok(++count <= 512 && !item.isSymbolicLink(), '主题业务原件条目超限或出现链接');
      if (depth === 0 && item.name === 'browser-profile' && item.isDirectory()) continue;
      const path = join(folder, item.name);
      if (item.isDirectory()) await visit(path, depth + 1);
      else if (item.isFile()) {
        try {
          report.retained_files.push(await fileIdentity(path));
        } catch (error) {
          report.retained_file_errors.push({ path, name: error.name, code: error.code });
        }
      }
    }
  };
  await visit(directory, 0);
  assert.equal(report.retained_file_errors.length, 0, '主题业务原件须全部可读');
  report.checkpoint_path = join(directory, 'checkpoint.json');
  await writeFile(report.checkpoint_path, JSON.stringify(report, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
}
