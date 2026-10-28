import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { strToU8, zipSync } from 'fflate';
import { inspectLocalRelease } from '../src/pages/marketplace/local-import/release.ts';
import { releaseArchive } from '../src/pages/marketplace/local-import/release-archive.ts';
import { previewLocalImport, submitLocalImport } from '../src/pages/marketplace/local-import/actions.ts';
import type { LocalImportPorts } from '../src/pages/marketplace/local-import/actions.ts';
import { marketInstallationSource } from '../src/features/plugin-installations/index.ts';
import { crc32 } from '../src/pages/marketplace/upload-preparation/zip-directory.ts';
import type { MarketplaceEntry } from '../src/features/marketplace/index.ts';
import { release } from './plugin-installations-fixture.ts';
import { signal } from './fixtures.ts';

const unused = async (): Promise<never> => { throw new Error('不应调用旧安装或市场端口'); };
const checksum = (bytes: Uint8Array) => [...sha256(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
function offlineFile(missing = false, component = strToU8('组件归档的原始字节')) {
  const manifest = { format_version: 1, host_api_version: 2, id: 'example-release', version: '1.0.0',
    name: '示例功能', description: '两个组件一起安装', components: [{ id: 'example-browser', kind: 'browser', version: '1.0.0',
      variants: [{ platform: 'any', path: 'components/browser.zip', format: 'zip', sha256: checksum(component), size: component.byteLength }] }], tools: [] };
  const content = zipSync({ 'release.json': strToU8(JSON.stringify(manifest)), ...(missing ? {} : { 'components/browser.zip': component }) }, { level: 0 });
  return new File([new Uint8Array(content)], 'example-release.zip', { type: 'application/zip' });
}
function ports(): LocalImportPorts {
  return { packages: { upload: unused }, serverPlugins: { refresh: unused }, artifacts: { upload: unused },
    tools: { importLocal: unused }, settings: { list: unused, import: unused }, configurations: { get: unused, save: unused } };
}

test('完整离线 ZIP 预览并上传产物后统一安装，不使用旧包上传', async () => {
  const file = offlineFile();
  const digest = checksum(new Uint8Array(await file.arrayBuffer()));
  const calls: string[] = [];
  const dependencies: LocalImportPorts = { ...ports(), installationArtifacts: { upload: async (filename, content) => {
    assert.equal(filename, file.name);
    assert.equal(content, file);
    calls.push('artifact');
    return { data: { id: 'artifact-release', filename, sha256: digest, size: content.size, media_type: 'application/zip', created_at: 1 }, logId: 'upload-log' };
  } }, installations: { install: async (source) => {
    calls.push('install');
    assert.deepEqual(source, { kind: 'offline', artifactId: 'artifact-release' });
    return release(true);
  } } };
  const preview = await previewLocalImport(dependencies, { kind: 'plugin', file, manifest: null, moduleId: '' }, signal());
  assert.equal(preview.kind, 'release');
  assert.match(preview.target, /示例功能/);
  assert.match(await submitLocalImport(dependencies, preview, signal()), /已安装并启用/);
  assert.deepEqual(calls, ['artifact', 'install']);
});

test('同版本重新导入在预览时固定原安装修订，提交走统一更新且保留停用意图', async () => {
  const file = offlineFile();
  const digest = checksum(new Uint8Array(await file.arrayBuffer()));
  const calls: string[] = [];
  const current = release(false);
  const dependencies: LocalImportPorts = { ...ports(),
    installationArtifacts: { upload: async filename => {
      calls.push('artifact');
      return { data: { id: 'artifact-new', filename, sha256: digest, size: file.size, media_type: 'application/zip', created_at: 1 }, logId: 'upload' };
    } },
    installations: {
      install: unused,
      refresh: async () => { calls.push('list'); return { data: [current], logId: 'directory' }; },
      update: async (id, expected, source) => {
        calls.push('update');
        assert.equal(id, current.id);
        assert.equal(expected, 'a'.repeat(64));
        assert.deepEqual(source, { kind: 'offline', artifactId: 'artifact-new' });
        return release(false, '1.0.0', 'b'.repeat(64));
      },
    },
  };
  const preview = await previewLocalImport(dependencies, { kind: 'plugin', file, manifest: null, moduleId: '' }, signal());
  assert.equal(preview.kind, 'release');
  if (preview.kind !== 'release') return;
  assert.equal(preview.expectedRevision, current.revision);
  assert.match(preview.summary, /更新/);
  assert.match(await submitLocalImport(dependencies, preview, signal()), /保持停用/);
  assert.deepEqual(calls, ['list', 'artifact', 'update']);
});

test('离线清单的资源缺失时在上传前阻断', async () => {
  await assert.rejects(inspectLocalRelease(offlineFile(true), signal()), /资源缺失或大小不一致/);
});

test('大资源预览仅切片读取目录与清单，不读取完整文件', async () => {
  const ranges: number[] = [];
  class SlicedFile extends File {
    override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('禁止整包读取'); }
    override slice(start?: number, end?: number, contentType?: string): Blob {
      ranges.push((end ?? this.size) - (start ?? 0));
      return super.slice(start, end, contentType);
    }
  }
  const source = offlineFile(false, new Uint8Array(2 * 1024 * 1024));
  const file = new SlicedFile([source], source.name);
  assert.equal((await inspectLocalRelease(file, signal()))?.id, 'example-release');
  assert.ok(ranges.every((length) => length <= 65557));
  assert.ok(ranges.reduce((total, length) => total + length, 0) < 100 * 1024);
});

test('清单声明展开长度偏小时拒绝，即使截断前缀 CRC 匹配', async () => {
  const content = strToU8(`{"format_version":1}${' '.repeat(128 * 1024)}`);
  const archive = zipSync({ 'release.json': content });
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const directory = view.getUint32(archive.byteLength - 6, true);
  const fakeSize = 32;
  // 同时伪造本地头和目录，仍须发现真实展开结果超出声明。
  const checksum = crc32(content.subarray(0, fakeSize));
  view.setUint32(14, checksum, true);
  view.setUint32(directory + 16, checksum, true);
  view.setUint32(22, fakeSize, true);
  view.setUint32(directory + 24, fakeSize, true);
  await assert.rejects(releaseArchive(new File([new Uint8Array(archive)], 'forged.zip'), signal()), /大小或 CRC 不一致/);
});

test('清单 CRC 损坏与预览取消都不接受导入', async () => {
  const archive = zipSync({ 'release.json': strToU8('{"format_version":1}') });
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const directory = view.getUint32(archive.byteLength - 6, true);
  view.setUint32(directory + 16, view.getUint32(directory + 16, true) ^ 1, true);
  await assert.rejects(releaseArchive(new File([new Uint8Array(archive)], 'corrupt.zip'), signal()), /大小或 CRC 不一致/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(inspectLocalRelease(offlineFile(), controller.signal), { name: 'AbortError' });
});

test('市场统一清单使用资源内容 URL 并保留摘要，不接受凭证来源', () => {
  const entry: MarketplaceEntry = { metadata_version: 1, kind: 'plugin', id: 'example-release', name: '示例功能', version: '1.0.0',
    summary: '示例', description: '示例', keywords: [], categories: ['function'], applies_to: ['deviceforge'], supports_mcp: 'none',
    supports_agent: false, restart_policy: 'none', platforms: [], architectures: [], source: 'https://market.test/root/', sourceName: '市场',
    resource_id: 'a'.repeat(64), details: { release_format: 1 } };
  assert.deepEqual(marketInstallationSource(entry), { kind: 'market', sourceUrl: `https://market.test/root/api/v1/resources/${'a'.repeat(64)}`,
    releaseId: 'example-release', version: '1.0.0', releaseDigest: 'a'.repeat(64) });
  assert.deepEqual(marketInstallationSource({ ...entry, details: { release_format_version: 1, host_api_version: 2 } }),
    marketInstallationSource(entry), '接受真实发布器输出的完整发布标记');
  assert.throws(() => marketInstallationSource({ ...entry, source: 'https://user:password@market.test' }), /市场来源/);
  assert.throws(() => marketInstallationSource({ ...entry, details: {} }), /统一发布格式/);
});
