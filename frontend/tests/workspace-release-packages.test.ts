import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'it-tar';
import { createReleasePackageSources, prepareReleasePackages } from '../scripts/workspace-release-packages.ts';
import type { ReleaseProject } from '../scripts/workspace-release-inputs.ts';

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
  const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-release-provenance-'));
  try {
    const frontend = resolve(import.meta.dirname, '..');
    for (const path of ['sdk/dist/deviceforge-plugin-sdk-0.1.0.tgz', 'contracts/dist/deviceforge-contracts-0.1.0.tgz',
      'sdk/dist/deviceforge-plugin-manifest-0.1.0.tgz']) {
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      await copyFile(join(frontend, path), join(temporary, path));
    }
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
      metadata: { dependencies: { '@fixture/shared': `file:../dependencies/${name}.tgz` } },
    }));
    const signal = AbortSignal.timeout(10000);
    await assert.rejects(prepareReleasePackages(temporary, join(temporary, 'different'), projects, signal), /不同来源或字节/);
    await copyFile(join(temporary, 'dependencies/one.tgz'), join(temporary, 'dependencies/two.tgz'));
    const prepared = await prepareReleasePackages(temporary, join(temporary, 'identical'), projects, signal);
    assert.equal(prepared.packages.length, 4);
    assert.ok(prepared.imports['@fixture/shared']?.endsWith('index.js'));
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
    await rm(temporary, { recursive: true, force: true });
  }
});
