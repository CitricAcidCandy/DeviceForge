import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { pack } from 'it-tar';
import { assembledBrowserManifest, completedPluginRelease, freezeReleaseSources, sealPreparedProject, verifyPreparedProject } from '../scripts/workspace-release-resume.ts';
import { auditBrowserBundle } from '../scripts/browser-bundle-closure.ts';
import { workspacePluginEntry } from '../scripts/workspace-plugin-entry.ts';
import { hash, readObject, releaseSourceIdentity } from '../scripts/workspace-release-inputs.ts';
import type { ReleaseProject } from '../scripts/workspace-release-inputs.ts';

let temporary = '';
const styles = 'export function acquireStyles() { return () => {}; }\n';
const distFiles = ['dist/index.js', 'dist/plugin-entry.js', 'dist/styles.js'];
before(async () => { temporary = await mkdtemp(join(tmpdir(), 'deviceforge-release-resume-')); });
after(async () => {
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
  await rm(temporary, { recursive: true, force: true });
});

async function fixture(name: string) {
  const root = join(temporary, name, 'source'), buildRoot = join(temporary, name, 'build');
  const metadata = { name: '@fixture/resume', version: '0.1.0', type: 'module' };
  const manifest = { manifest_version: 1, id: 'resume_fixture', version: '0.1.0', name: '接续夹具',
    components: [{ kind: 'browser', files: ['dist'], entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } } }] };
  const source = 'export default (identity: object) => ({ ...identity, panels: [] });\n';
  for (const directory of [root, buildRoot]) {
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(join(directory, 'src/index.ts'), source);
    await writeFile(join(directory, 'package.json'), JSON.stringify(metadata));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  }
  const project: ReleaseProject = { root, id: manifest.id, name: metadata.name, version: manifest.version,
    entry: join(root, 'src/index.ts'), metadata, manifest };
  const code = 'export default { id: "resume_fixture", version: "0.1.0", apiVersion: 2, panels: [] };\n';
  await mkdir(join(buildRoot, 'dist'));
  await writeFile(join(buildRoot, 'dist/index.js'), code);
  await writeFile(join(buildRoot, 'dist/plugin-entry.js'), workspacePluginEntry());
  await writeFile(join(buildRoot, 'dist/styles.js'), styles);
  await writeFile(join(buildRoot, 'manifest.json'), JSON.stringify(assembledBrowserManifest(project, distFiles)));
  return { root, buildRoot, project, code };
}

async function componentArchive(code: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const members = new Map([
    ['package/package.json', JSON.stringify({ name: '@fixture/resume', version: '0.1.0', type: 'module',
      deviceforge: { kind: 'browser', manifest: 'plugin.json',
        entrypoints: { any: { runtime: 'browser', path: '.deviceforge-entry.js' } } } })],
    ['package/plugin.json', JSON.stringify({ id: 'resume_fixture', version: '0.1.0', api_version: 2 })],
    ['package/.deviceforge-entry.js', 'import create from "./dist/plugin-entry.js";\nexport default await create({ id: "resume_fixture", version: "0.1.0", apiVersion: 2 });\n'],
    ['package/dist/index.js', code],
    ['package/dist/plugin-entry.js', workspacePluginEntry()],
    ['package/dist/styles.js', styles],
  ]);
  for await (const chunk of pack()([...members].map(([name, text]) => ({
    header: { name, size: Buffer.byteLength(text) }, body: Buffer.from(text),
  })))) chunks.push(chunk);
  return gzipSync(Buffer.concat(chunks));
}

async function releaseFixture(name: string, deliveredCode?: string) {
  const current = await fixture(name), directory = join(temporary, name, 'release');
  const component = await componentArchive(current.code);
  const delivered = deliveredCode === undefined ? component : await componentArchive(deliveredCode);
  const path = `blobs/${hash(delivered)}`;
  const release = { format_version: 2, host_api_version: 2, id: current.project.id, version: current.project.version,
    name: '接续夹具', description: '只用于单元验证', components: [{ id: current.project.id, kind: 'browser',
      version: current.project.version, variants: [{ platform: 'any', format: 'tgz', path,
        size: delivered.length, sha256: hash(delivered) }] }], tools: [], requirements: [],
    dependencies: { format_version: 1, dependencies: [] } };
  const bytes = zipSync({ 'release.json': Buffer.from(JSON.stringify(release)),
    'market.json': Buffer.from('{}'), [path]: delivered });
  await mkdir(join(directory, 'components'), { recursive: true });
  await writeFile(join(directory, 'components', `${current.project.id}.tgz`), component);
  await writeFile(join(directory, 'release.json'), JSON.stringify(release));
  const archive = join(directory, 'resume_fixture-0.1.0-any.zip');
  await writeFile(archive, bytes);
  const report = { id: current.project.id, version: current.project.version, archive,
    size: bytes.length, sha256: hash(bytes) };
  await writeFile(join(directory, 'pack-report.json'), JSON.stringify(report));
  return { ...current, directory, archive, report };
}

test('显式接续认可相同源码与清单的已构建工程且不改写原文件，未创建的工程返回未就绪', async () => {
  const current = await fixture('same');
  const before = await releaseSourceIdentity(current.buildRoot);
  const code = await readFile(join(current.buildRoot, 'dist/index.js'));
  assert.equal(await verifyPreparedProject(current.project, current.buildRoot), true);
  assert.deepEqual(await releaseSourceIdentity(current.buildRoot), before);
  assert.deepEqual(await readFile(join(current.buildRoot, 'dist/index.js')), code);
  assert.equal(await verifyPreparedProject(current.project, join(temporary, 'absent-build')), false);
});

test('显式接续拒绝已构建工程的源码或包元数据变化，不覆盖旧构建', async () => {
  const current = await fixture('changed-source');
  await writeFile(join(current.root, 'src/index.ts'), 'export default () => null;');
  await assert.rejects(verifyPreparedProject(current.project, current.buildRoot), /源码与本次工程不同/);
  const changedMetadata = await fixture('changed-metadata');
  await writeFile(join(changedMetadata.root, 'package.json'), '{"name":"@fixture/changed","type":"module"}');
  await assert.rejects(verifyPreparedProject(changedMetadata.project, changedMetadata.buildRoot), /源码与本次工程不同/);
});

test('显式接续认可最终归档、旁路组件和dist一致的发布，不改写回执', async () => {
  const current = await releaseFixture('completed');
  const before = await readFile(join(current.directory, 'pack-report.json'));
  const result = await completedPluginRelease(current.directory, current.project, current.buildRoot);
  assert.deepEqual(result, { id: current.project.id, version: current.project.version, archive: current.archive,
    bytes: current.report.size, sha256: current.report.sha256 });
  assert.deepEqual(await readFile(join(current.directory, 'pack-report.json')), before);
});

test('显式接续拒绝旧发布组件与当前dist字节不同，保留现有归档', async () => {
  const current = await releaseFixture('changed-dist');
  const before = await readFile(current.archive);
  await writeFile(join(current.buildRoot, 'dist/index.js'), 'export default { changed: true };');
  await assert.rejects(completedPluginRelease(current.directory, current.project, current.buildRoot), /资源与本次构建不同/);
  assert.deepEqual(await readFile(current.archive), before);
});

test('显式接续必须核对最终ZIP内组件，不能只凭自洽回执和旁路TGZ复用不同实现', async () => {
  const current = await releaseFixture('different-offline-component', 'export default { differentImplementation: true };');
  const before = await readFile(current.archive);
  await assert.rejects(completedPluginRelease(current.directory, current.project, current.buildRoot));
  assert.deepEqual(await readFile(current.archive), before);
});

test('接续基线缺失时默认拒绝，不写新证据或覆盖原失败记录', async () => {
  const output = join(temporary, 'missing-baseline');
  await mkdir(output);
  const failure = '{"state":"failed","message":"保留原始错误"}\n';
  await writeFile(join(output, 'build-failure.json'), failure);
  const sources = [{ id: 'first', files: [{ name: 'src/index.ts', sha256: 'first-source' }] }];
  await assert.rejects(freezeReleaseSources(output, sources, { resume: true }));
  await assert.rejects(readFile(join(output, 'source-baseline.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(output, 'build-failure.json'), 'utf8'), failure);
});

test('接续基线仅在显式接纳旧批次时晚建立，并保留晚建立身份而非初始证据', async () => {
  const output = join(temporary, 'adopted-baseline');
  await mkdir(output);
  const sources = [{ id: 'first', files: [{ name: 'src/index.ts', sha256: 'adopted-source' }] }];
  await freezeReleaseSources(output, sources, { resume: true, adoptCurrentInputs: true });
  const path = join(output, 'source-baseline.json');
  const baseline = await readObject(path), before = await readFile(path);
  assert.equal(baseline.origin, 'explicit_legacy_adoption');
  assert.deepEqual(baseline.sources, sources);
  await freezeReleaseSources(output, sources, { resume: true });
  assert.deepEqual(await readFile(path), before);
});

test('接续基线在首建时保存，重复首建不覆盖，字节相同的接续保持原证据', async () => {
  const output = join(temporary, 'initial-baseline');
  await mkdir(output);
  const sources = [{ id: 'first', files: [{ name: 'src/index.ts', sha256: 'initial-source' }] }];
  await freezeReleaseSources(output, sources, { resume: false });
  const path = join(output, 'source-baseline.json');
  const baseline = await readObject(path), before = await readFile(path);
  assert.equal(baseline.origin, 'initial');
  assert.deepEqual(baseline.sources, sources);
  await assert.rejects(freezeReleaseSources(output, sources, { resume: false }), /基线已存在.*不能覆盖/);
  await freezeReleaseSources(output, sources, { resume: true });
  assert.deepEqual(await readFile(path), before);
});

test('接续基线拒绝尚未创建构建目录的工程在两次运行间改变源码', async () => {
  const current = await fixture('unbuilt-source-baseline');
  const output = join(temporary, 'unbuilt-run'), absentBuild = join(output, 'builds', current.project.id);
  await mkdir(output);
  const sources = [{ id: current.project.id, files: await releaseSourceIdentity(current.root) }];
  await freezeReleaseSources(output, sources, { resume: false });
  const before = await readFile(join(output, 'source-baseline.json'));
  assert.equal(await verifyPreparedProject(current.project, absentBuild), false);
  await writeFile(join(current.root, 'src/index.ts'), 'export default () => ({ changedBetweenRuns: true });\n');
  const changed = [{ id: current.project.id, files: await releaseSourceIdentity(current.root) }];
  await assert.rejects(freezeReleaseSources(output, changed, { resume: true }));
  assert.deepEqual(await readFile(join(output, 'source-baseline.json')), before);
  assert.equal(await verifyPreparedProject(current.project, absentBuild), false);
});

test('接续基线拒绝新增或删除来源，显式接纳不能覆盖已有基线', async () => {
  const output = join(temporary, 'changed-source-set');
  await mkdir(output);
  const first = { id: 'first', files: [{ name: 'src/index.ts', sha256: 'first-source' }] };
  const second = { id: 'second', files: [{ name: 'src/index.ts', sha256: 'second-source' }] };
  await freezeReleaseSources(output, [first], { resume: false });
  const path = join(output, 'source-baseline.json'), before = await readFile(path);
  await assert.rejects(freezeReleaseSources(output, [first, second], { resume: true }));
  await assert.rejects(freezeReleaseSources(output, [], { resume: true }));
  await assert.rejects(freezeReleaseSources(output, [first, second], { resume: true, adoptCurrentInputs: true }));
  assert.deepEqual(await readFile(path), before);
});

test('显式接续封口只派生与原清单一致的完整旧构建，不重建或改写dist', async () => {
  const current = await fixture('seal-original');
  await writeFile(join(current.buildRoot, 'manifest.json'), JSON.stringify(current.project.manifest));
  const code = await readFile(join(current.buildRoot, 'dist/index.js'));
  assert.equal(await verifyPreparedProject(current.project, current.buildRoot), true);
  const closure = await auditBrowserBundle(join(current.buildRoot, 'dist'));
  assert.deepEqual(await sealPreparedProject(current.project, current.buildRoot, closure), distFiles);
  const manifest = await readObject(join(current.buildRoot, 'manifest.json'));
  assert.deepEqual(manifest, assembledBrowserManifest(current.project, distFiles));
  const record = await readFile(join(current.buildRoot, 'bundle-closure.json'));
  await sealPreparedProject(current.project, current.buildRoot, closure);
  assert.deepEqual(await readFile(join(current.buildRoot, 'bundle-closure.json')), record);
  assert.deepEqual(await readFile(join(current.buildRoot, 'dist/index.js')), code);
  assert.equal(await verifyPreparedProject(current.project, current.buildRoot), true);
});

test('显式接续封口拒绝未知清单或已有闭包记录变化，不覆盖原记录', async () => {
  const unknown = await fixture('seal-unknown-manifest');
  const unexpected = JSON.stringify({ ...unknown.project.manifest, name: '未知外部修改' });
  await writeFile(join(unknown.buildRoot, 'manifest.json'), unexpected);
  const closure = await auditBrowserBundle(join(unknown.buildRoot, 'dist'));
  await assert.rejects(sealPreparedProject(unknown.project, unknown.buildRoot, closure), /未知变化/);
  assert.equal(await readFile(join(unknown.buildRoot, 'manifest.json'), 'utf8'), unexpected);
  await assert.rejects(readFile(join(unknown.buildRoot, 'bundle-closure.json')), { code: 'ENOENT' });
  const changed = await fixture('seal-changed-record');
  const record = '{"unknown":"保留已有记录"}\n';
  await writeFile(join(changed.buildRoot, 'bundle-closure.json'), record);
  await assert.rejects(sealPreparedProject(changed.project, changed.buildRoot,
    await auditBrowserBundle(join(changed.buildRoot, 'dist'))), /闭包记录.*拒绝覆盖/);
  assert.equal(await readFile(join(changed.buildRoot, 'bundle-closure.json'), 'utf8'), record);
});

test('显式接续封口在闭包冲突时保持原始未派生清单与闭包字节不变', async () => {
  const current = await fixture('seal-conflict-before-manifest');
  const manifestPath = join(current.buildRoot, 'manifest.json');
  const closurePath = join(current.buildRoot, 'bundle-closure.json');
  const originalManifest = await readFile(join(current.root, 'manifest.json'));
  await writeFile(manifestPath, originalManifest);
  await writeFile(closurePath, '{"unknown":"保留已有闭包"}\n');
  const originalClosure = await readFile(closurePath);
  const closure = await auditBrowserBundle(join(current.buildRoot, 'dist'));
  await assert.rejects(sealPreparedProject(current.project, current.buildRoot, closure), /闭包记录.*拒绝覆盖/);
  assert.deepEqual(await readFile(manifestPath), originalManifest);
  assert.deepEqual(await readFile(closurePath), originalClosure);
});
