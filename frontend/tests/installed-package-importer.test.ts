import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInstalledPackageImporter,
  installedPackageUrl,
} from '../src/app/installed-package-importer.ts';

test('已安装模块入口限定当前服务原点及公开运行代次路径', () => {
  const base = 'http://localhost:7031';
  const entry = '/api/v2/browser-plugins/workspace/runs/run-1/assets/index.js';
  assert.equal(installedPackageUrl(base, entry), base + entry);
  for (const invalid of [
    'https://other.example' + entry,
    '/src/app/main.ts',
    '/assets/index.js',
    entry + '?token=example',
    entry + '#fragment',
    'http://user:password@localhost:7031' + entry,
    '/api/v2/browser-plugins/workspace/runs/run-1/assets/../../other.js',
  ])
    assert.throws(() => installedPackageUrl(base, invalid));
});

test('撤销后不开始模块导入', async () => {
  await assert.rejects(
    createInstalledPackageImporter('http://localhost:7031')(
      '/api/v2/browser-plugins/workspace/runs/run-1/assets/index.js',
      AbortSignal.abort(),
    ),
    /已取消/,
  );
});
