import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { strToU8, zipSync } from 'fflate';
import { inspectLocalRelease } from '../src/pages/marketplace/local-import/release.ts';
import { previewLocalImport, submitLocalImport } from '../src/pages/marketplace/local-import/actions.ts';
import type { LocalImportPorts } from '../src/pages/marketplace/local-import/actions.ts';
import { marketInstallationSource } from '../src/features/plugin-installations/index.ts';
import type { MarketplaceEntry } from '../src/features/marketplace/index.ts';
import { release } from './plugin-installations-fixture.ts';
import { signal } from './fixtures.ts';

const unused = async (): Promise<never> => { throw new Error('不应调用旧安装或市场端口'); };
const checksum = (bytes: Uint8Array) => [...sha256(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
function offlineFile(missing = false) {
  const component = strToU8('组件归档的原始字节');
  const manifest = { format_version: 1, host_api_version: 2, id: 'example-release', version: '1.0.0',
    name: '示例功能', description: '两个组件一起安装', components: [{ id: 'example-browser', kind: 'browser', version: '1.0.0',
      variants: [{ platform: 'any', path: 'components/browser.zip', format: 'zip', sha256: checksum(component), size: component.byteLength }] }], tools: [] };
  const content = zipSync({ 'release.json': strToU8(JSON.stringify(manifest)), ...(missing ? {} : { 'components/browser.zip': component }) });
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

test('离线清单的资源缺失时在上传前阻断', async () => {
  await assert.rejects(inspectLocalRelease(offlineFile(true), signal()), /资源缺失或大小不一致/);
});

test('市场统一清单使用资源内容 URL 并保留摘要，不接受凭证来源', () => {
  const entry: MarketplaceEntry = { metadata_version: 1, kind: 'plugin', id: 'example-release', name: '示例功能', version: '1.0.0',
    summary: '示例', description: '示例', keywords: [], categories: ['function'], applies_to: ['deviceforge'], supports_mcp: 'none',
    supports_agent: false, restart_policy: 'none', platforms: [], architectures: [], source: 'https://market.test/root/', sourceName: '市场',
    resource_id: 'a'.repeat(64), details: { release_format: 1 } };
  assert.deepEqual(marketInstallationSource(entry), { kind: 'market', sourceUrl: `https://market.test/root/api/v1/resources/${'a'.repeat(64)}`,
    releaseId: 'example-release', version: '1.0.0', releaseDigest: 'a'.repeat(64) });
  assert.throws(() => marketInstallationSource({ ...entry, source: 'https://user:password@market.test' }), /市场来源/);
  assert.throws(() => marketInstallationSource({ ...entry, details: {} }), /统一发布格式/);
});
