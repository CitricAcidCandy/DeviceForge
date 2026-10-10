import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { validatePackages } from './check-architecture.mjs';

const root = resolve('backend-fixture');
function graph(dependency, kind = null, name = 'apk-application', location = 'crates/application') {
  return {
    workspace_members: ['a', 'b'], packages: [
      { id: 'a', name, manifest_path: resolve(root, location, 'Cargo.toml'), dependencies: [{ name: dependency, kind }] },
      { id: 'b', name: 'apk-infrastructure', manifest_path: resolve(root, 'crates/infrastructure/Cargo.toml'), dependencies: [] },
    ],
  };
}
test('用例依赖适配器只允许出现在测试，重命名不会绕过真实包名检查', () => {
  assert.match(validatePackages(graph('apk-infrastructure'), root).join(), /不得依赖/);
  assert.deepEqual(validatePackages(graph('apk-infrastructure', 'dev'), root), []);
  assert.match(validatePackages(graph('apk-infrastructure', 'build'), root).join(), /不得依赖/);
});
test('独立插件禁止引用宿主；领域禁止新增框架依赖和工程外私有路径', () => {
  assert.match(validatePackages(graph('apk-infrastructure', null, 'demo-plugin', 'plugins/demo'), root).join(), /不得依赖/);
  assert.match(validatePackages(graph('axum', null, 'apk-domain', 'crates/domain'), root).join(), /领域边界/);
  const metadata = graph('outside'); metadata.packages[0].dependencies[0].path = resolve(root, '../outside');
  assert.match(validatePackages(metadata, root).join(), /工程外/);
});

test('工具公共库不得引用宿主或框架，生产和构建依赖均受约束', () => {
  for (const kind of [null, 'build']) {
    assert.match(validatePackages(graph('apk-infrastructure', kind, 'deviceforge-tool-process', 'crates/tool-process'), root).join(), /不得依赖/);
    assert.match(validatePackages(graph('axum', kind, 'deviceforge-tool-process', 'crates/tool-process'), root).join(), /领域边界/);
  }
});

test('工具公共库只供适配器和独立插件使用，领域和用例不能绕过端口', () => {
  for (const [name, location, allowed] of [
    ['apk-infrastructure', 'crates/infrastructure', true],
    ['device-plugin', 'plugins/device', true],
    ['apk-domain', 'crates/domain', false],
    ['apk-application', 'crates/application', false],
    ['apk-plugin-sdk', 'crates/plugin-sdk', false],
  ]) {
    const metadata = graph('deviceforge-tool-process', null, name, location);
    metadata.workspace_members.push('tool');
    metadata.packages.push({ id: 'tool', name: 'deviceforge-tool-process', manifest_path: resolve(root, 'crates/tool-process/Cargo.toml'), dependencies: [{ name: 'tokio', kind: null }] });
    const failures = validatePackages(metadata, root);
    if (allowed) assert.deepEqual(failures, []);
    else assert.match(failures.join(), /不得依赖/);
  }
});

test('包规则公共库不得引用宿主、异步框架或 SDK，构建依赖不能绕过约束', () => {
  for (const kind of [null, 'build']) {
    for (const dependency of ['apk-infrastructure', 'tokio', 'axum', 'apk-plugin-sdk']) {
      assert.notDeepEqual(validatePackages(graph(dependency, kind,
        'deviceforge-android-package-core', 'crates/android-package-core'), root), []);
    }
    for (const dependency of ['zip', 'quick-xml', 'serde', 'thiserror']) {
      assert.deepEqual(validatePackages(graph(dependency, kind,
        'deviceforge-android-package-core', 'crates/android-package-core'), root), []);
    }
  }
});

test('包规则公共库只由副作用适配器和独立插件消费，宿主其他层不得直接导入', () => {
  for (const [name, location, allowed] of [
    ['apk-infrastructure', 'crates/infrastructure', true],
    ['android-plugin', 'plugins/android', true],
    ['apk-domain', 'crates/domain', false],
    ['apk-application', 'crates/application', false],
    ['apk-server', 'crates/server', false],
    ['apk-plugin-sdk', 'crates/plugin-sdk', false],
    ['deviceforge-tool-process', 'crates/tool-process', false],
  ]) {
    const metadata = graph('deviceforge-android-package-core', null, name, location);
    metadata.workspace_members.push('package-core');
    metadata.packages.push({ id: 'package-core', name: 'deviceforge-android-package-core',
      manifest_path: resolve(root, 'crates/android-package-core/Cargo.toml'),
      dependencies: [{ name: 'zip', kind: null }] });
    const failures = validatePackages(metadata, root);
    if (allowed) assert.deepEqual(failures, []);
    else assert.match(failures.join(), /不得依赖/);
  }
});
