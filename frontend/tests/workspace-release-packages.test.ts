import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'it-tar';
import { createReleasePackageSources, prepareReleasePackages } from '../scripts/workspace-release-packages.ts';
import type { ReleaseProject } from '../scripts/workspace-release-inputs.ts';
import { pluginManifestRoot } from '../scripts/package-plugin-manifest.ts';

test('公开配套包不因名称命中而遮蔽另一声明的来源或版本', () => {
  const sources = createReleasePackageSources();
  const first = { kind: 'archive', path: 'first.tgz', sha256: 'first-bytes' } as const;
  sources.register('@fixture/shared', first);
  sources.register('@fixture/shared', { ...first, path: 'identical-copy.tgz' });
  assert.throws(() => sources.register('@fixture/shared', { ...first, sha256: 'different-version-bytes' }), /不同来源或字节/);
  assert.throws(() => sources.register('@fixture/shared', { kind: 'project', path: 'other-source', sha256: 'first-bytes' }), /不同来源或字节/);
  sources.register('@fixture/model', { kind: 'project', path: 'first-project', sha256: 'metadata' });
  assert.throws(() => sources.register('@fixture/model', { kind: 'project', path: 'second-project', sha256: 'metadata' }), /不同来源或字节/);
});

test('实际准备流程核对每个 file 声明，不复用同名但不同实现的 TGZ', async () => {
  const frontend = resolve(import.meta.dirname, '..');
  await mkdir(join(frontend, 'artifacts'), { recursive: true });
  const temporary = await mkdtemp(join(frontend, 'artifacts/deviceforge-release-provenance-'));
  try {
    await mkdir(join(temporary, 'dependencies'));
    async function sharedArchive(name: string, value: number) {
      const files = new Map([
        ['package.json', JSON.stringify({ name: '@fixture/shared', version: '1.0.0', type: 'module', exports: { '.': './index.js' } })],
        ['index.js', `export const value = ${value};`],
      ]);
      const chunks: Uint8Array[] = [];
      for await (const chunk of pack()([...files].map(([file, text]) => ({
        header: { name: `package/${file}`, size: Buffer.byteLength(text) }, body: Buffer.from(text),
      })))) chunks.push(chunk);
      await writeFile(join(temporary, 'dependencies', name), gzipSync(Buffer.concat(chunks)));
    }
    await sharedArchive('one.tgz', 1);
    await sharedArchive('two.tgz', 2);
    const projects: ReleaseProject[] = ['one', 'two'].map((name) => ({ root: join(temporary, name), id: name,
      name, version: '1.0.0', entry: '', manifest: {},
      metadata: { dependencies: { '@fixture/shared': `file:../dependencies/${name}.tgz`,
        '@deviceforge/plugin-manifest': `file:${pluginManifestRoot()}` } },
    }));
    const signal = AbortSignal.timeout(10000);
    await assert.rejects(prepareReleasePackages(temporary, join(temporary, 'different'), projects, signal, frontend), /不同来源或字节/);
    await copyFile(join(temporary, 'dependencies/one.tgz'), join(temporary, 'dependencies/two.tgz'));
    const prepared = await prepareReleasePackages(temporary, join(temporary, 'identical'), projects, signal, frontend);
    assert.equal(prepared.packages.length, 4);
    assert.ok(prepared.imports['@fixture/shared']?.endsWith('index.js'));
    const manifest = prepared.packages.find((entry) => entry.name === '@deviceforge/plugin-manifest');
    assert.ok(manifest);
    assert.deepEqual(await readFile(join(manifest.root, 'index.mjs')),
      await readFile(join(pluginManifestRoot(), 'index.mjs')));
    const rejected = [{ ...projects[0], root: join(temporary, 'wrong'), id: 'wrong', name: 'wrong', version: '1.0.0',
      entry: '', manifest: {}, metadata: { dependencies: { '@deviceforge/plugin-manifest': `file:${resolve(pluginManifestRoot(), '..')}` } } }];
    await assert.rejects(prepareReleasePackages(temporary, join(temporary, 'wrong-source'), rejected, signal, frontend), /发行范围/);
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(frontend, 'artifacts') + sep));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('公开SDK下载声明必须匹配已安装锁定来源，远端声明不能绕过来源核对', async () => {
  const frontend = resolve(import.meta.dirname, '..');
  const parent = join(frontend, 'artifacts');
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, 'deviceforge-release-installed-'));
  try {
    const lock: unknown = JSON.parse(await readFile(join(frontend, 'package-lock.json'), 'utf8'));
    assert.ok(lock && typeof lock === 'object' && 'packages' in lock && lock.packages && typeof lock.packages === 'object');
    assert.ok('node_modules/@deviceforge/plugin-sdk' in lock.packages);
    const installed = lock.packages['node_modules/@deviceforge/plugin-sdk'];
    assert.ok(installed && typeof installed === 'object' && 'resolved' in installed && typeof installed.resolved === 'string');
    assert.match(installed.resolved, /^https:\/\//);
    const project: ReleaseProject = { root: temporary, id: 'installed', name: 'installed', version: '1.0.0',
      entry: '', manifest: {}, metadata: { dependencies: { '@deviceforge/plugin-sdk': installed.resolved } } };
    const valid = await prepareReleasePackages(frontend, join(temporary, 'valid'), [project], AbortSignal.timeout(10000));
    assert.equal(valid.packages.length, 3);
    assert.ok(valid.imports['@deviceforge/plugin-sdk']?.endsWith('lib\\index.js') ||
      valid.imports['@deviceforge/plugin-sdk']?.endsWith('lib/index.js'));
    const mismatch = { ...project, metadata: { dependencies: { '@deviceforge/plugin-sdk': `${installed.resolved}?different` } } };
    await assert.rejects(prepareReleasePackages(frontend, join(temporary, 'mismatch'), [mismatch], AbortSignal.timeout(10000)), /来源.*不一致/);
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(parent) + sep));
    await rm(temporary, { recursive: true, force: true });
  }
});
