// 在产品宿主启动前验证全部夹具闭包；故障包只允许预先声明的摘要或入口错误。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { archiveMembers } from '../plugin-releases/archive.mjs';
import { validateDependencies } from '../plugin-releases/dependencies.mjs';
import { digest, identity } from './evidence.mjs';

export async function checkFixtures(fixtures) {
  const checked = { components: [], releases: [], faults: ['badDigest', 'missingEntry', 'network', 'noSource'] };
  for (const [name, fixture] of Object.entries(fixtures.components)) {
    const members = await archiveMembers(fixture.file, 'tgz');
    const descriptor = JSON.parse(members.get('package/package.json'));
    const plugin = JSON.parse(members.get('package/plugin.json'));
    assert.equal(plugin.id, fixture.target.id);
    assert.equal(descriptor.deviceforge.kind, fixture.target.kind);
    assert.ok(members.has(`package/${descriptor.deviceforge.entrypoints.any.path}`));
    if (members.has('package/dependencies.json')) {
      const dependencies = JSON.parse(members.get('package/dependencies.json'));
      validateDependencies(dependencies, { owner: fixture.target.id });
      assert.deepEqual(dependencies, fixture.dependencies);
    } else assert.deepEqual(fixture.dependencies.dependencies, []);
    assert.deepEqual(await readFile(fixture.file), fixture.archive, '上传字节必须等于已检查的落盘归档');
    checked.components.push({ name, target: fixture.target, identity: await identity(fixture.file) });
  }
  for (const [name, fixture] of Object.entries(fixtures.releases)) {
    const members = await archiveMembers(fixture.file, 'zip');
    const manifest = JSON.parse(members.get('release.json'));
    assert.equal(manifest.id, fixture.target.id);
    assert.equal(manifest.host_api_version, 2);
    assert.deepEqual(manifest.components.map(({ id, kind }) => ({ id, kind })), fixture.components);
    if (manifest.format_version === 2) {
      validateDependencies(manifest.dependencies, { components: new Set(fixture.components.map((value) => value.id)) });
      assert.deepEqual(manifest.dependencies, fixture.dependencies);
    } else {
      assert.equal(manifest.format_version, 1);
      assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
    }
    for (const component of manifest.components) {
      for (const variant of component.variants) {
        const bytes = members.get(variant.path);
        assert.ok(bytes, '发布必须携带每个声明的组件');
        assert.equal(bytes.length, variant.size);
        assert.equal(digest(bytes), variant.sha256);
      }
    }
    if (fixture.runtimeDependency) {
      const script = await archiveMembers(fixture.componentFile, 'tgz');
      const descriptor = JSON.parse(script.get('package/package.json'));
      assert.deepEqual(descriptor.deviceforge.entrypoints.any, {
        runtime: 'script', path: 'index.mjs', dependency: fixture.runtimeDependency,
      });
      assert.equal(script.has('package/.deviceforge-runtime.json'), false, '输入包不得伪造宿主运行时 marker');
      assert.equal(script.has('package/manifest.json'), false, '输入包不得伪造宿主生成清单');
      assert.ok(script.has('package/index.mjs'));
      const sidecar = JSON.parse(script.get('package/dependencies.json'));
      validateDependencies(sidecar, { owner: fixture.component.id });
      if (!fixture.runtimeSidecar) assert.deepEqual(sidecar.dependencies, [], 'release-only 夹具必须真实省去组件依赖声明');
      const runtime = (fixture.runtimeSidecar ? sidecar : manifest.dependencies).dependencies
        .find((value) => value.id === fixture.runtimeDependency.id);
      assert.equal(runtime.required, true); assert.ok(runtime.probe); assert.ok(runtime.sources.length > 0);
      assert.ok(runtime.entries.includes(fixture.runtimeDependency.entry));
      assert.equal(digest(await readFile(fixture.componentFile)), manifest.components[0].variants[0].sha256);
    }
    checked.releases.push({ name, target: fixture.target, format_version: manifest.format_version,
      identity: await identity(fixture.file) });
  }
  const toolMembers = await archiveMembers(fixtures.archiveIdentity.path, 'zip');
  assert.equal(toolMembers.size, 1);
  assert.equal(digest(toolMembers.get('node.exe')), fixtures.node.sha256, '下载包必须包含本次真实 Node 原字节');
  assert.equal((await identity(fixtures.envProgram)).sha256, fixtures.node.sha256);
  assert.equal((await identity(fixtures.userProgram)).sha256, fixtures.node.sha256);
  const a = fixtures.releases.a.dependencies.dependencies[0], b = fixtures.releases.b.dependencies.dependencies[0];
  assert.deepEqual({ ...a, bindings: [] }, { ...b, bindings: [] }, 'A/B 必须使用相同稳定依赖身份与来源');
  const badDigest = fixtures.releases.badDigest.dependencies.dependencies[1];
  assert.equal(badDigest.required, false);
  assert.notEqual(badDigest.sources[0].sha256, fixtures.archiveIdentity.sha256);
  const missingEntry = fixtures.releases.missingEntry.dependencies.dependencies[1];
  assert.equal(missingEntry.required, false);
  const missingArchive = fixtures.sources['/node-missing-entry.zip'];
  assert.notEqual(missingArchive.sha256, fixtures.archiveIdentity.sha256, '缺入口场景不能被成功归档的缓存掩盖');
  assert.equal((await archiveMembers(missingArchive.path, 'zip')).has(missingEntry.sources[0].entries.main), false);
  assert.equal(missingEntry.sources[0].sha256, missingArchive.sha256);
  assert.equal(missingEntry.sources[0].size, missingArchive.size);
  const networkArchive = fixtures.sources['/node-network.zip'];
  assert.notEqual(networkArchive.sha256, fixtures.archiveIdentity.sha256, '网络失败来源必须具有独立内容身份');
  assert.equal((await archiveMembers(networkArchive.path, 'zip', { collect: false })).has('node-network.exe'), true);
  assert.deepEqual(fixtures.releases.noSource.dependencies.dependencies[0].sources, []);
  checked.tool = fixtures.archiveIdentity;
  checked.sources = fixtures.sources;
  return checked;
}
