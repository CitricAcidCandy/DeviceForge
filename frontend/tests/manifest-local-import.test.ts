import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { zipSync, unzipSync } from 'fflate';
import { prepareUpload } from '../src/pages/marketplace/upload-preparation/prepare.ts';
import { readTgz, writeArchive } from '../src/pages/marketplace/upload-preparation/archives.ts';
import { inspectLocalRelease } from '../src/pages/marketplace/local-import/release.ts';
import { previewLocalImport, submitLocalImport, type LocalImportPorts } from '../src/pages/marketplace/local-import/actions.ts';
import type { UploadSelection, ArchiveFile } from '../src/pages/marketplace/upload-preparation/types.ts';
import { release } from './plugin-installations-fixture.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const text = new TextDecoder();
const digest = (bytes: Uint8Array) => [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const signal = () => new AbortController().signal;
const unused = async (): Promise<never> => { throw new Error('预览不得触发安装、市场或设备'); };
function ports(): LocalImportPorts {
  return { packages: { upload: unused }, serverPlugins: { refresh: unused }, artifacts: { upload: unused },
    tools: { importLocal: unused }, settings: { list: unused, import: unused }, configurations: { get: unused, save: unused } };
}
function declaration() {
  return { manifest_version: 1, id: 'example-release', version: '1.0.0', name: '示例功能', description: '插件开发只维护一份清单',
    market: { summary: '离线导入测试', keywords: ['中文'], author: '开发者', supports_mcp: 'server', supports_agent: true },
    components: [{ kind: 'browser', files: ['index.js'], entrypoints: { any: { runtime: 'browser', path: 'index.js' } } }] };
}
function files(value: unknown = declaration()): ArchiveFile[] {
  return [{ path: 'manifest.json', bytes: encode(value) }, { path: 'index.js', bytes: new TextEncoder().encode('export default ({id}) => ({panels: []});') }];
}
function directory(input = files()): UploadSelection {
  return { mode: 'directory', name: '开发工程', files: input.map(file => ({ path: file.path, file: new File([new Uint8Array(file.bytes)], file.path) })) };
}
function archive(bytes: Uint8Array, name = '工程.zip'): UploadSelection {
  const file = new File([new Uint8Array(bytes)], name);
  return { mode: 'archive', name, files: [{ path: name, file }] };
}

test('本地单清单目录自动生成完整格式2离线包，预览和提交使用生成字节', async () => {
  const selection = directory();
  const file = selection.files[0]?.file;
  assert.ok(file);
  const local = ports();
  const preview = await previewLocalImport(local, { kind: 'plugin', file, selection, manifest: null, moduleId: '' }, signal(), prepareUpload);
  assert.equal(preview.kind, 'release');
  assert.notEqual(preview.file, file);
  const contents = unzipSync(new Uint8Array(await preview.file.arrayBuffer()));
  const manifest = JSON.parse(text.decode(contents['release.json']));
  const market = JSON.parse(text.decode(contents['market.json']));
  assert.equal(manifest.format_version, 2);
  assert.equal(market.summary, '离线导入测试');
  assert.equal(market.id, manifest.id);
  assert.equal(market.supports_agent, true);
  const component = manifest.components[0];
  const blob = contents[component.variants[0].path];
  assert.ok(blob);
  assert.equal(digest(blob), component.variants[0].sha256);
  const members = await readTgz(blob, true);
  const pkg = JSON.parse(text.decode(members.find(item => item.path === 'package/package.json')?.bytes));
  assert.equal(pkg.version, '1.0.0');
  assert.equal(pkg.deviceforge.entrypoints.any.path, '.deviceforge-entry.js');
  assert.ok(members.some(item => item.path === 'package/.deviceforge-entry.js'));
  assert.ok(!members.some(item => item.path === 'package/manifest.json'));
  assert.equal((await inspectLocalRelease(preview.file, signal()))?.id, manifest.id);
  const calls: string[] = [];
  const installPorts: LocalImportPorts = { ...local, installationArtifacts: { upload: async (filename, content) => {
    assert.equal(content, preview.file);
    calls.push('artifact');
    return { data: { id: 'generated', filename, size: content.size, sha256: preview.kind === 'release' ? preview.sha256 : '', media_type: 'application/zip', created_at: 1 }, logId: 'local' };
  } }, installations: { install: async () => { calls.push('install'); return release(true); } } };
  assert.match(await submitLocalImport(installPorts, preview, signal()), /已安装并启用/);
  assert.deepEqual(calls, ['artifact', 'install']);
});

test('ZIP与npm TGZ单清单无需旧元数据，外包一层工程目录也可导入', async () => {
  for (const tgz of [false, true]) {
    const selection = archive(await writeArchive(files().map(file => ({ ...file, path: '工程/' + file.path })), tgz), tgz ? '工程.tgz' : '工程.zip');
    const result = await prepareUpload({ kind: 'plugin', selection, localImport: true });
    assert.ok('inspection' in result);
    assert.equal(result.inspection.release?.id, 'example-release');
    assert.match(result.file.name, /\.zip$/);
    assert.equal((await inspectLocalRelease(result.file, signal()))?.componentCount, 1);
  }
});

test('配套服务器与浏览器共用身份版本，组件ID与运行时保持各自声明', async () => {
  const value = declaration();
  const input = { ...value, components: [value.components[0], { kind: 'server', root: 'server', files: ['main.mjs'],
    entrypoints: { any: { runtime: 'node', path: 'main.mjs' } }, plugin: { operations: [] } }] };
  const result = await prepareUpload({ kind: 'plugin', localImport: true, selection: directory([...files(input), { path: 'server/main.mjs', bytes: new TextEncoder().encode('// 不执行') }]) });
  assert.ok('inspection' in result);
  assert.equal(result.inspection.release?.componentCount, 2);
  const entries = unzipSync(new Uint8Array(await result.file.arrayBuffer()));
  const release = JSON.parse(text.decode(entries['release.json']));
  assert.deepEqual(release.components.map((item: { id: string }) => item.id), ['example-release.browser', 'example-release.server']);
  assert.ok(release.components.every((item: { version: string }) => item.version === value.version));
});

test('本地依赖生成真实摘要与资源闭包，依赖原包缺失不能导入', async () => {
  const payload = new TextEncoder().encode('工具数据，不执行');
  const value = { ...declaration(), dependencies: { format_version: 1, dependencies: [{ id: 'tool', name: '工具', version_requirement: '*', entries: ['bin'], sources: [] }] },
    dependency_files: { tool: { file: 'tool.bin', platform: 'win32-x64', version: '1.0.0', format: 'file', entries: { bin: 'payload' } } } };
  await assert.rejects(prepareUpload({ kind: 'plugin', localImport: true, selection: directory(files(value)) }), /依赖缺真实文件/);
  const result = await prepareUpload({ kind: 'plugin', localImport: true, selection: directory([...files(value), { path: 'tool.bin', bytes: payload }]) });
  assert.ok('inspection' in result);
  const entries = unzipSync(new Uint8Array(await result.file.arrayBuffer()));
  const release = JSON.parse(text.decode(entries['release.json']));
  const dependency = release.dependencies.dependencies[0].sources[0];
  assert.equal(dependency.sha256, digest(payload));
  assert.deepEqual(entries[dependency.url], payload);
  assert.ok(await inspectLocalRelease(result.file, signal()));
  delete entries[dependency.url];
  await assert.rejects(inspectLocalRelease(new File([new Uint8Array(zipSync(entries))], 'broken.zip'), signal()), /资源缺失/);
});

test('市场单组件目录共用清单派生规则，身份和市场字段不需重复维护', async () => {
  const result = await prepareUpload({ kind: 'plugin', selection: directory() });
  assert.ok('inspection' in result);
  assert.equal(result.inspection.identity?.id, 'example-release');
  assert.equal(result.inspection.metadata?.author, '开发者');
  const contents = unzipSync(new Uint8Array(await result.file.arrayBuffer()));
  assert.ok(contents['package.json']);
  assert.ok(contents['plugin.json']);
  assert.ok(!contents['release.json']);
});

test('重复身份、漏构建产物、无效市场与脚本缺运行时都在上传前失败', async () => {
  const value = declaration();
  for (const invalid of [
    { ...value, market: { id: 'duplicated' } },
    { ...value, market: { supports_mcp: 'unknown' } },
    { ...value, components: [{ ...value.components[0], files: ['missing.js'] }] },
    { ...value, components: [{ kind: 'server', files: ['index.js'], entrypoints: { any: { runtime: 'script', path: 'index.js' } } }] },
  ]) await assert.rejects(prepareUpload({ kind: 'plugin', localImport: true, selection: directory(files(invalid)) }));
  const controller = new AbortController();
  controller.abort();
  const source = directory().files[0]?.file;
  assert.ok(source);
  await assert.rejects(previewLocalImport(ports(), { kind: 'plugin', file: source, selection: directory(), manifest: null, moduleId: '' }, controller.signal, prepareUpload), { name: 'AbortError' });
});
