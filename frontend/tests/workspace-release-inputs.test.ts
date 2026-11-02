import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'it-tar';
import { releaseProjects, releaseSourceIdentity, unpackPublicPackage } from '../scripts/workspace-release-inputs.ts';

let temporary = '';
before(async () => { temporary = await mkdtemp(join(tmpdir(), 'deviceforge-release-inputs-')); });
after(async () => {
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
  await rm(temporary, { recursive: true, force: true });
});
async function project(directory: string, id: string, exports?: unknown) {
  const root = join(directory, id);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/index.ts'), 'export default (identity: object) => identity;\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@fixture/${id}`, type: 'module', exports }));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 1, id, version: '0.1.0',
    components: [{ kind: 'browser', files: ['dist'], entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } } }] }));
  return root;
}
async function archive(name: string, entries: readonly (readonly [string, string])[]) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack()(entries.map(([path, content]) => {
    const body = Buffer.from(content);
    return { header: { name: path, size: body.length }, body };
  }))) chunks.push(chunk);
  const path = join(temporary, `${name}.tgz`);
  await writeFile(path, gzipSync(Buffer.concat(chunks)));
  return path;
}

test('发行从真实清单动态发现源入口，新增来源不需宿主数组', async () => {
  const root = join(temporary, 'sources');
  await project(root, 'second', { '.': { development: './src/index.ts' } });
  await project(root, 'first', { '.': './src/index.ts' });
  const fallback = await project(root, 'third');
  const projects = await releaseProjects(root);
  assert.deepEqual(projects.map((value) => value.id), ['first', 'second', 'third']);
  assert.equal(projects[2]?.entry, join(fallback, 'src/index.ts'));
  await project(root, 'fourth');
  assert.equal((await releaseProjects(root)).length, 4);
});

test('发行拒绝空目录和越界入口，不用宿主文件补齐', async () => {
  const root = join(temporary, 'invalid');
  await mkdir(root);
  await assert.rejects(releaseProjects(root), /不能为空/);
  await project(root, 'invalid', { '.': '../outside.ts' });
  await assert.rejects(releaseProjects(root), /自身工程内部/);
});

test('真实公开 SDK 归档解出实际运行与声明出口，拒绝覆盖', async () => {
  const root = join(temporary, 'sdk');
  const result = await unpackPublicPackage(resolve(import.meta.dirname, '../sdk/dist/deviceforge-plugin-sdk-0.1.0.tgz'), root);
  assert.equal(result.name, '@deviceforge/plugin-sdk');
  assert.equal(result.imports['@deviceforge/plugin-sdk'], join(root, 'lib/index.js'));
  assert.equal(result.declarations['@deviceforge/plugin-sdk'], join(root, 'lib/index.d.ts'));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok((await readFile(result.imports['@deviceforge/plugin-sdk'] ?? '')).length > 0);
  await assert.rejects(unpackPublicPackage(result.archive, root), /EEXIST/);
});

test('公开开发包越界、重复成员及未交付出口在写盘前拒绝', async () => {
  const metadata = JSON.stringify({ name: '@fixture/library', version: '0.1.0', type: 'module',
    exports: { '.': './index.js' } });
  const samples: readonly (readonly [string, readonly (readonly [string, string])[], RegExp])[] = [
    ['escape', [['package/package.json', metadata], ['package/../escape.js', '']], /越界成员/],
    ['duplicate', [['package/package.json', metadata], ['package/index.js', ''], ['package/index.js', '']], /重复身份/],
    ['missing', [['package/package.json', metadata]], /未交付的文件/],
  ];
  for (const [name, entries, message] of samples) {
    const output = join(temporary, `unpack-${name}`);
    const file = await archive(name, entries);
    await assert.rejects(unpackPublicPackage(file, output), message);
    await assert.rejects(readFile(join(output, 'package.json')), /ENOENT/);
  }
});

test('发行源身份包含单清单与本包资源变化，不把生成产物当输入', async () => {
  const root = await project(join(temporary, 'identity'), 'source_identity');
  const before = await releaseSourceIdentity(root);
  assert.deepEqual(before.map((entry) => entry.name), ['src/index.ts', 'package.json', 'manifest.json']);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.js'), 'not-source');
  assert.deepEqual(await releaseSourceIdentity(root), before);
  await writeFile(join(root, 'src/preset.json'), '{"value":1}');
  const changed = await releaseSourceIdentity(root);
  assert.notDeepEqual(changed, before);
  assert.ok(changed.some((entry) => entry.name === 'src/preset.json'));
});

test('公开开发包的名称和固定版本不能参与路径逃逸', async () => {
  for (const [name, version] of [['@fixture/package', '../../../outside'], ['../../outside', '0.1.0']]) {
    const metadata = JSON.stringify({ name, version, type: 'module', exports: { '.': './index.js' } });
    const file = await archive(`identity-${version === '0.1.0' ? 'name' : 'version'}`, [
      ['package/package.json', metadata], ['package/index.js', 'export {};'],
    ]);
    await assert.rejects(unpackPublicPackage(file, join(temporary, `invalid-${version === '0.1.0' ? 'name' : 'version'}`)), /固定身份/);
  }
});
