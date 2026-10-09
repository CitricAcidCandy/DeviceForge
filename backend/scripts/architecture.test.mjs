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
