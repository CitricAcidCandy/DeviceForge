import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inside } from '../../cli/src/paths.mjs';
import { copyNativePluginAssets, loadNativePluginAssets } from '../native-plugin-assets.mjs';
import { loadNativePluginSource } from '../native-plugin-source.mjs';

async function fixture(run) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'deviceforge-plugin-assets-'));
  const source = join(root, 'source');
  const output = join(root, 'package');
  try {
    await mkdir(join(source, 'worker', 'dist'), { recursive: true });
    await mkdir(output);
    await writeFile(join(source, 'manifest.json'), '{"id":"asset-test"}');
    await writeFile(
      join(source, 'worker', 'dist', 'index.js'),
      'export const message = "中文资源";',
    );
    await writeFile(join(source, 'worker', 'package.json'), '{"type":"module"}');
    await run({ root, source, output });
  } finally {
    const target = resolve(root);
    assert.ok(target !== parent && inside(parent, target));
    await rm(target, { recursive: true, force: true });
  }
}

async function declaration(source, files, api_version = 1) {
  await writeFile(join(source, 'package-assets.json'), JSON.stringify({ api_version, files }));
}

const entry = { source: 'worker/dist/index.js', target: 'bin/worker/dist/index.js' };

test('旧插件无静态声明仍兼容，声明成员保留旁置结构和原字节', async () => {
  await fixture(async ({ source, output }) => {
    assert.deepEqual((await loadNativePluginSource(source)).assets, []);
    await writeFile(join(source, 'ai-sdk.config.json'), '{"private":"不自动采集"}');
    await declaration(source, [
      entry,
      { source: 'worker/package.json', target: 'bin/worker/package.json' },
    ]);
    const assets = (await loadNativePluginSource(source)).assets;
    assert.equal(assets.length, 2);
    await copyNativePluginAssets(assets, output, ['bin/tool.exe']);
    assert.deepEqual(
      await readFile(join(output, entry.target)),
      await readFile(join(source, entry.source)),
    );
    assert.equal(
      await readFile(join(output, 'bin/worker/package.json'), 'utf8'),
      '{"type":"module"}',
    );
    await assert.rejects(readFile(join(output, 'bin/ai-sdk.config.json')), { code: 'ENOENT' });
  });
});

test('构建前后的成员变化拒绝发布，缺失声明成员不能静默遗漏', async () => {
  await fixture(async ({ source, output }) => {
    await declaration(source, [entry]);
    const assets = await loadNativePluginAssets(source);
    await writeFile(join(source, entry.source), 'export const changed = true;');
    await assert.rejects(copyNativePluginAssets(assets, output), /构包期间变化/);
    await declaration(source, [{ source: 'worker/dist/missing.js', target: entry.target }]);
    await assert.rejects(loadNativePluginAssets(source), { code: 'ENOENT' });
  });
});

test('静态声明拒绝越界路径、未知字段、错误版本及非法数量', async () => {
  await fixture(async ({ source }) => {
    for (const files of [
      [],
      Array.from({ length: 65 }, () => entry),
      [{ ...entry, source: '../outside.js' }],
      [{ ...entry, target: 'bin/../outside.js' }],
      [{ ...entry, target: 'worker/index.js' }],
      [{ ...entry, extra: true }],
    ]) {
      await declaration(source, files);
      await assert.rejects(loadNativePluginAssets(source));
    }
    await declaration(source, [entry], 2);
    await assert.rejects(loadNativePluginAssets(source), /版本1/);
    await writeFile(
      join(source, 'package-assets.json'),
      JSON.stringify({ api_version: 1, files: [entry], extra: true }),
    );
    await assert.rejects(loadNativePluginAssets(source), /版本1/);
  });
});

test('成员大小写重复、目录前缀冲突和入口模板覆盖全部拒绝', async () => {
  await fixture(async ({ source, output }) => {
    for (const files of [
      [entry, { ...entry, target: entry.target.toUpperCase().replace('BIN/', 'bin/') }],
      [{ ...entry, target: 'bin/worker' }, { ...entry, target: 'bin/worker-name' }, entry],
    ]) {
      await declaration(source, files);
      await assert.rejects(loadNativePluginAssets(source), /冲突/);
    }
    await declaration(source, [entry]);
    const assets = await loadNativePluginAssets(source);
    await assert.rejects(
      copyNativePluginAssets(assets, output, ['BIN/WORKER/DIST/INDEX.JS']),
      /冲突/,
    );
    await assert.rejects(copyNativePluginAssets(assets, output, ['bin/worker']), /冲突/);
  });
});

test('静态文件和总字节限额由实际读取控制', async () => {
  await fixture(async ({ source }) => {
    await writeFile(join(source, 'worker', 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await declaration(source, [{ source: 'worker/large.bin', target: 'bin/large.bin' }]);
    await assert.rejects(loadNativePluginAssets(source), /单文件上限/);
    await writeFile(join(source, 'worker', 'large.bin'), Buffer.alloc(8 * 1024 * 1024));
    await declaration(
      source,
      Array.from({ length: 5 }, (_, ordinal) => ({
        source: 'worker/large.bin',
        target: `bin/large-${ordinal}.bin`,
      })),
    );
    await assert.rejects(loadNativePluginAssets(source), /总量上限/);
  });
});

test('声明经目录链接引用源根以外的文件时拒绝', async () => {
  await fixture(async ({ root, source }) => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'entry.js'), '不能复制');
    await symlink(
      outside,
      join(source, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await declaration(source, [{ source: 'linked/entry.js', target: 'bin/entry.js' }]);
    await assert.rejects(loadNativePluginAssets(source), /非链接普通文件/);
  });
});
