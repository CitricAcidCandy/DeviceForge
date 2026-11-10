import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { extract } from 'it-tar';
import ts from 'typescript';
import { packagePluginManifest, pluginManifestRoot } from '../scripts/package-plugin-manifest.ts';

test('清单规则真实 TGZ 在独立工程消费，不要求宿主源码或不存在的本地依赖', async () => {
  const frontend = resolve(import.meta.dirname, '..');
  const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-manifest-package-'));
  try {
    const built = await packagePluginManifest(join(temporary, 'distribution'));
    assert.equal(built.root, await realpath(pluginManifestRoot()));
    await assert.rejects(packagePluginManifest(built.root), /不能写入公开源码/);
    const bytes = await readFile(built.archive);
    const root = join(temporary, 'node_modules/@deviceforge/plugin-manifest');
    const files = new Map<string, Buffer>();
    for await (const entry of extract()([gunzipSync(bytes)])) {
      assert.ok(entry.header.name.startsWith('package/'));
      const name = entry.header.name.slice('package/'.length), target = resolve(root, name);
      assert.ok(target.startsWith(resolve(root) + sep));
      const chunks: Uint8Array[] = [];
      for await (const chunk of entry.body) chunks.push(chunk.subarray());
      const content = Buffer.concat(chunks);
      files.set(name, content);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
    }
    assert.equal(files.size, 12);
    for (const [name, content] of files) {
      assert.deepEqual(content, await readFile(join(built.root, name)), `归档必须来自当前公开源码：${name}`);
      if (name.endsWith('.mjs') || name.endsWith('.d.ts'))
        assert.doesNotMatch(content.toString('utf8'), /(?:\.\.\/)+(?:frontend|cli)|[A-Z]:\\/);
    }
    const metadata: unknown = JSON.parse(files.get('package.json')?.toString('utf8') ?? 'null');
    assert.ok(metadata && typeof metadata === 'object' && 'name' in metadata && 'dependencies' in metadata);
    assert.equal(metadata.name, '@deviceforge/plugin-manifest');
    assert.deepEqual(metadata.dependencies, { semver: '7.8.5' });
    await cp(join(frontend, '../node_modules/semver'), join(temporary, 'node_modules/semver'), { recursive: true });
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
    const source = join(temporary, 'index.ts');
    await writeFile(source, [
      'import { normalizeManifest, componentMetadata } from "@deviceforge/plugin-manifest";',
      'export const declaration = normalizeManifest({});',
      'const component = declaration.components[0];',
      'if (!component) throw new Error("清单缺少组件");',
      'export const entries = componentMetadata(declaration, component, { format_version: 1, dependencies: [] });',
    ].join('\n'));
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, types: [] });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
    assert.equal(program.getSourceFiles().some((file) => resolve(file.fileName).startsWith(join(frontend, 'src') + sep)), false);
    const actual = await import(pathToFileURL(join(root, 'index.mjs')).href);
    const declaration: unknown = JSON.parse(await readFile(join(frontend, 'plugins/marketplace/manifest.json'), 'utf8'));
    const normalized = actual.normalizeManifest(declaration);
    assert.equal(normalized.id, 'deviceforge_marketplace');
    assert.equal(normalized.components[0]?.entrypoints.any.path, 'dist/index.js');
    assert.ok(actual.componentMetadata(normalized, normalized.components[0], normalized.release.dependencies)
      .has('.deviceforge-entry.js'));
    assert.match(createHash('sha256').update(bytes).digest('hex'), /^[a-f0-9]{64}$/);
  } finally {
    const checked = resolve(temporary);
    assert.ok(checked.startsWith(resolve(tmpdir()) + sep));
    await rm(checked, { recursive: true, force: true });
  }
});
