// 复用已有真实组件夹具，仅在本次临时目录补中文字段及共享资源发布。
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { browserReleaseFixture } from '../plugin-installations-browser-smoke/fixtures.mjs';
import { verifyEntries, writeZip } from '../plugin-releases/archive.mjs';
import { digestBytes, jsonBytes, packRelease, verifyReleaseDirectory } from '../plugin-releases/pack.mjs';
import { releaseResources, validateRelease } from '../plugin-releases/contract.mjs';

export async function publicationFixtures(root) {
  const base = await browserReleaseFixture(root);
  const sourceDirectory = dirname(base.market);
  const previous = await verifyReleaseDirectory(base.directory);
  const server = previous.manifest.components.find((item) => item.kind === 'server');
  const members = await verifyEntries(previous.files.get(server.variants[0].sha256), server.variants[0]);
  const plugin = JSON.parse(members.get('package/plugin.json'));
  plugin.configuration.schema.title = '网页发布基础配置';
  plugin.configuration.schema.properties.helper.title = '托管工具绑定';
  plugin.configuration.schema.properties.helper.description = '由宿主根据共享资源声明绑定实际入口。';
  plugin.configuration.schema.properties.setting.title = '配置内容';
  plugin.configuration.schema.properties.setting.description = '保存后通过公开 SDK 调用真实服务器组件核对。';
  members.set('package/plugin.json', jsonBytes(plugin));
  await writeFile(join(sourceDirectory, 'server.tgz'), npmTgz([...members].map(([path, bytes]) => ({
    path: path.replace(/^package\//, ''), bytes,
  }))));
  const source = JSON.parse(await readFile(join(sourceDirectory, 'source.json'), 'utf8'));
  source.name = '网页完整功能验收';
  source.description = '由网页拆分发布服务器、浏览器与共享工具，验证中文配置和公开 SDK 调用。';
  const market = JSON.parse(await readFile(base.market, 'utf8'));
  Object.assign(market, { name: source.name, description: source.description, summary: '完整 ZIP 网页发布与成套安装验收' });
  await writeFile(join(sourceDirectory, 'source.json'), jsonBytes(source));
  await writeFile(base.market, jsonBytes(market));
  const directory = join(sourceDirectory, 'publication-release');
  const packed = await packRelease({ source: join(sourceDirectory, 'source.json'),
    inputs: join(sourceDirectory, 'inputs.json'), destination: directory, platform: 'win32-x64' });
  const verified = await verifyReleaseDirectory(directory);
  const first = { ...base, ...packed, directory, name: source.name, manifest: verified.manifest };

  const sharedDirectory = join(root, 'shared-component-release');
  await mkdir(sharedDirectory);
  await mkdir(join(sharedDirectory, 'blobs'));
  const manifest = structuredClone(first.manifest);
  manifest.id = 'third_party_shared';
  manifest.name = '网页共享组件验收';
  manifest.description = '复用同市场已发布的两份组件与共享工具，仅上传新增资源和本发布清单。';
  const extra = Buffer.from('第二发布独有资源\n');
  const variant = { platform: 'any', path: `blobs/${digestBytes(extra)}`, size: extra.length,
    sha256: digestBytes(extra), format: 'file', entries: { main: 'payload' } };
  manifest.tools.push({ id: 'extra_helper', version: '1.0.0', required: false, variants: [variant], bindings: [] });
  validateRelease(manifest);
  for (const resource of releaseResources(first.manifest))
    await copyFile(verified.files.get(resource.sha256), join(sharedDirectory, resource.path));
  await writeFile(join(sharedDirectory, variant.path), extra);
  await writeFile(join(sharedDirectory, 'release.json'), jsonBytes(manifest));
  const archive = join(sharedDirectory, `${manifest.id}-${manifest.version}-win32-x64.zip`);
  await writeZip(archive, [{ name: 'release.json', bytes: jsonBytes(manifest) },
    ...releaseResources(manifest).map((resource) => ({ name: resource.path, path: join(sharedDirectory, resource.path) }))]);
  await verifyReleaseDirectory(sharedDirectory);
  const shared = { id: manifest.id, version: manifest.version, name: manifest.name, directory: sharedDirectory,
    archive, manifest, serverId: first.serverId, browserId: first.browserId };
  assert.deepEqual(manifest.components, first.manifest.components, '第二发布必须原样复用两份真实组件');
  const conflictManifest = structuredClone(first.manifest);
  conflictManifest.description = '同一发布身份的不同清单必须被真实市场拒绝，旧条目不能被覆盖。';
  const conflictArchive = join(root, 'conflicting-release.zip');
  await writeZip(conflictArchive, [{ name: 'release.json', bytes: jsonBytes(conflictManifest) },
    ...releaseResources(first.manifest).map((resource) => ({ name: resource.path, path: verified.files.get(resource.sha256) }))]);
  const conflict = { ...first, archive: conflictArchive, manifest: conflictManifest };
  return { first, shared, conflict };
}

export function publicFixtures(fixtures) {
  return Object.fromEntries(Object.entries(fixtures).map(([key, value]) => [key, {
    id: value.id, version: value.version, name: value.name, serverId: value.serverId, browserId: value.browserId,
    filename: basename(value.archive), file: `/__publication/fixtures/${key}`,
  }]));
}
