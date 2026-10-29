import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { workspacePackagePaths, workspacePluginPackages } from '../scripts/workspace-plugin-packages.ts';

function fixture() {
  const prefix = join(tmpdir(), 'deviceforge-workspace-public-');
  const root = mkdtempSync(prefix);
  return {
    root,
    project(name: string, metadata: unknown) {
      const path = join(root, 'plugins', name);
      mkdirSync(join(path, 'src'), { recursive: true });
      writeFileSync(join(path, 'src', 'index.ts'), 'export const value = 1;\n');
      writeFileSync(join(path, 'package.json'), JSON.stringify(metadata));
    },
    dispose() {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(resolve(root).startsWith(resolve(prefix)));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('独立包公开出口自动参与宿主开发解析，无需固定业务别名清单', () => {
  const current = fixture();
  try {
    current.project('sample', {
      name: '@example/sample',
      exports: {
        '.': { development: './src/index.ts', import: './dist/index.js' },
        './model': { development: './src/index.ts', types: './dist/model.d.ts' },
      },
    });
    const result = workspacePluginPackages(current.root);
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.aliases.map((entry) => entry.find), ['@example/sample/model', '@example/sample']);
    assert.deepEqual(workspacePackagePaths(current.root, result)['@example/sample/model'], ['./plugins/sample/src/index.ts']);
  } finally { current.dispose(); }
});

test('错误或越界出口只排除对应工程，其他公开包仍可解析', () => {
  const current = fixture();
  try {
    current.project('good', { name: '@example/good', exports: { '.': './src/index.ts' } });
    current.project('bad', { name: '@example/bad', exports: { '.': { development: '../good/src/index.ts' } } });
    const result = workspacePluginPackages(current.root);
    assert.deepEqual(result.aliases.map((entry) => entry.find), ['@example/good']);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.project, 'bad');
  } finally { current.dispose(); }
});

test('重复公开包出口全部排除，不以文件或加载顺序接管另一工程', () => {
  const current = fixture();
  try {
    for (const name of ['first', 'second'])
      current.project(name, { name: '@example/same', exports: { '.': './src/index.ts' } });
    const result = workspacePluginPackages(current.root);
    assert.equal(result.aliases.length, 0);
    assert.match(result.diagnostics[0]?.message ?? '', /相同公开出口/);
  } finally { current.dispose(); }
});
