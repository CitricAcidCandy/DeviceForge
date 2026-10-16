import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync, unzipSync, zipSync } from 'fflate';
import { pack } from 'it-tar';
import { sha256 } from '@noble/hashes/sha2.js';
import { prepareUpload } from '../src/pages/marketplace/upload-preparation/prepare.ts';
import { readTgz } from '../src/pages/marketplace/upload-preparation/archives.ts';
import { MAX_FILE_COUNT, safeRelativePath, validateFiles } from '../src/pages/marketplace/upload-preparation/rules.ts';
import { createMarketplacePublishEntry, initialMarketplaceUploadDraft } from '../src/pages/marketplace/upload.ts';
import type { ArchiveFile, UploadSelection } from '../src/pages/marketplace/upload-preparation/types.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const metadata = createMarketplacePublishEntry({ ...initialMarketplaceUploadDraft, id: 'demo.plugin', name: '中文插件', summary: '多层目录测试', details: '{"plugin_kind":"browser"}' }, 'pending');
function pluginFiles(): ArchiveFile[] {
  return [
    { path: 'package.json', bytes: encode({ version: '1.0.0', deviceforge: { kind: 'browser', manifest: 'plugin.json', entrypoints: { browser: { runtime: 'module', path: 'dist/main.js' } } } }) },
    { path: 'plugin.json', bytes: encode({ id: 'demo.plugin', version: '1.0.0', api_version: 2 }) },
    { path: 'dist/main.js', bytes: new TextEncoder().encode('export default {}') },
    { path: '素材/多层/说明.txt', bytes: new TextEncoder().encode('中文内容') },
  ];
}
function directory(files = pluginFiles()): UploadSelection {
  return { mode: 'directory', name: '中文插件', files: files.map(item => ({ path: item.path, file: new File([new Uint8Array(item.bytes).buffer], item.path.split('/').at(-1) ?? 'file') })) };
}
function archived(bytes: Uint8Array, name = 'demo.zip'): UploadSelection {
  const file = new File([new Uint8Array(bytes).buffer], name);
  return { mode: 'archive', name, files: [{ path: name, file }] };
}

test('中文多层文件夹生成根目录ZIP、排除版本目录并同步市场描述与最终摘要', async () => {
  const selection = directory([...pluginFiles(), { path: '.git/config', bytes: encode('ignored') }]);
  const inspected = await prepareUpload({ selection, kind: 'plugin' });
  assert.ok(!('inspection' in inspected));
  assert.equal(inspected.identity?.id, 'demo.plugin');
  assert.deepEqual(inspected.excluded, ['.git/config']);
  const result = await prepareUpload({ selection, kind: 'plugin', metadata });
  assert.ok('inspection' in result);
  const bytes = new Uint8Array(await result.file.arrayBuffer());
  const files = unzipSync(bytes);
  assert.ok(files['package.json']);
  assert.ok(files['素材/多层/说明.txt']);
  assert.ok(!files['.git/config']);
  const embedded = JSON.parse(new TextDecoder().decode(files['market.json']));
  assert.equal(embedded.name, '中文插件');
  assert.ok(!('resource_id' in embedded));
  assert.equal(result.sha256, Buffer.from(sha256(bytes)).toString('hex'));
});

test('ZIP导入market自动填表且修改后覆盖包内元数据', async () => {
  const source = Object.fromEntries([...pluginFiles(), { path: 'market.json', bytes: encode(metadata) }].map(file => [file.path, file.bytes]));
  const selection = archived(zipSync(source));
  const inspected = await prepareUpload({ selection, kind: 'plugin' });
  assert.ok(!('inspection' in inspected));
  assert.equal(inspected.metadata?.name, metadata.name);
  const result = await prepareUpload({ selection, kind: 'plugin', metadata: { ...metadata, summary: '修改后的简介' } });
  assert.ok('inspection' in result);
  const content = unzipSync(new Uint8Array(await result.file.arrayBuffer()));
  assert.equal(JSON.parse(new TextDecoder().decode(content['market.json'])).summary, '修改后的简介');
});

test('TGZ保持npm package根并保留实际文件路径', async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack()(pluginFiles().map(file => ({ header: { name: `package/${file.path}`, type: 'file' }, body: file.bytes })))) chunks.push(chunk);
  const selection = archived(gzipSync(Buffer.concat(chunks)), 'demo.tgz');
  const result = await prepareUpload({ selection, kind: 'plugin', metadata });
  assert.ok('inspection' in result);
  const files = await readTgz(new Uint8Array(await result.file.arrayBuffer()), true);
  assert.ok(files.every(file => file.path.startsWith('package/')));
  assert.ok(files.some(file => file.path === 'package/market.json'));
});

test('单媒体保留原字节，工具和配置目录保持相对路径', async () => {
  const file = new File([new Uint8Array([0, 3, 9, 255])], '画面.mp4', { type: 'video/mp4' });
  const result = await prepareUpload({ selection: { mode: 'file', name: file.name, files: [{ path: file.name, file }] }, kind: 'resource', metadata: { ...metadata, kind: 'resource', visibility: 'internal' } });
  assert.ok('inspection' in result);
  assert.equal(result.file, file);
  assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()), new Uint8Array([0, 3, 9, 255]));
  for (const kind of ['tool', 'config'] as const) {
    const packed = await prepareUpload({ selection: directory([{ path: '子目录/a.json', bytes: encode({ enabled: true }) }]), kind, metadata: { ...metadata, kind } });
    assert.ok('inspection' in packed);
    assert.ok(unzipSync(new Uint8Array(await packed.file.arrayBuffer()))['子目录/a.json']);
  }
});

test('插件身份、版本、运行位置与未构建入口冲突均阻止发布', async () => {
  for (const patch of [{ id: 'another' }, { version: '2.0.0' }, { details: { plugin_kind: 'server' } }])
    await assert.rejects(prepareUpload({ selection: directory(), kind: 'plugin', metadata: { ...metadata, ...patch } }), /不一致/);
  const files = pluginFiles();
  files[0] = { path: 'package.json', bytes: encode({ version: '1.0.0', deviceforge: { kind: 'browser', manifest: 'plugin.json', entrypoints: { browser: { path: 'src/main.ts' } } } }) };
  await assert.rejects(prepareUpload({ selection: directory(files), kind: 'plugin' }), /尚未构建/);
});

test('越界、重复、大小写冲突和文件目录冲突均拒绝', async () => {
  for (const path of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', 'a/./b']) assert.throws(() => safeRelativePath(path));
  for (const files of [[{ path: 'a', bytes: encode(1) }, { path: 'A', bytes: encode(2) }], [{ path: 'a', bytes: encode(1) }, { path: 'a/b', bytes: encode(2) }]]) assert.throws(() => validateFiles(files, false), /重复|冲突/);
  await assert.rejects(prepareUpload({ selection: archived(zipSync({ '../bad': encode(0) })), kind: 'tool' }), /路径无效/);
});

test('项数和声明大小超限在读入内容前失败，空包和损坏归档拒绝', async () => {
  const files = Array.from({ length: MAX_FILE_COUNT + 1 }, (_, index) => ({ path: `f${index}`, bytes: new Uint8Array() }));
  assert.throws(() => validateFiles(files, false), /4096/);
  const large = new File(['x'], 'big.exe');
  Object.defineProperty(large, 'size', { value: 65 * 1024 * 1024 });
  await assert.rejects(prepareUpload({ selection: { mode: 'directory', name: 'big', files: [{ path: 'big.exe', file: large }] }, kind: 'plugin' }), /64 MiB/);
  await assert.rejects(prepareUpload({ selection: archived(new Uint8Array([1, 2, 3])), kind: 'plugin' }));
  const valid = zipSync({ 'a.txt': new Uint8Array([1, 2, 3]) }, { level: 0 });
  await assert.rejects(prepareUpload({ selection: archived(valid.subarray(0, valid.length - 3)), kind: 'tool' }), /截断/);
  const corrupt = valid.slice();
  corrupt[35] = (corrupt[35] ?? 0) ^ 0xff;
  await assert.rejects(prepareUpload({ selection: archived(corrupt), kind: 'tool' }), /校验/);
});
