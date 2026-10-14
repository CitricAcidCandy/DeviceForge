import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePluginPlan, selectPluginPlans, verifyNativeHost } from '../native-plugin-plan.mjs';

const crate = {
  id: 'test-crate',
  name: 'example-plugin',
  version: '1.2.0',
  license: 'MIT',
  targets: [{ name: 'example-plugin', kind: ['bin'] }],
};
const manifest = {
  id: 'example',
  version: '1.2.0',
  executable: '机器相关旧入口',
  protocol_version: 2,
  operations: [],
};

test('原生分发保留契约，去除机器入口并以 Cargo 版本和平台约束发布', () => {
  const plan = nativePluginPlan(crate, manifest, 'win32', 'x64');
  assert.equal(plan.entry, 'bin/example-plugin.exe');
  assert.deepEqual(plan.packageJson.os, ['win32']);
  assert.deepEqual(plan.packageJson.cpu, ['x64']);
  assert.equal(plan.packageJson.deviceforge.entrypoints['win32-x64'].runtime, 'native');
  assert.ok(!('executable' in plan.portableManifest));
  assert.equal(manifest.executable, '机器相关旧入口');
  assert.throws(() => nativePluginPlan(crate, { ...manifest, version: '2.0.0' }), /版本不一致/);
  assert.throws(
    () =>
      nativePluginPlan(
        { ...crate, targets: [...crate.targets, { name: 'other', kind: ['bin'] }] },
        manifest,
      ),
    /唯一二进制/,
  );
});

test('分发选择拒绝未知、重复 ID 与归一化后的包名碰撞', () => {
  const plan = nativePluginPlan(crate, manifest);
  assert.deepEqual(selectPluginPlans([plan], ['example']), [plan]);
  assert.throws(() => selectPluginPlans([plan], ['unknown']), /不存在/);
  assert.throws(() => selectPluginPlans([plan], ['example', 'example']), /不能重复/);
  const collision = nativePluginPlan(crate, { ...manifest, id: 'other' });
  assert.throws(
    () => selectPluginPlans([plan, { ...collision, packageJson: plan.packageJson }]),
    /冲突/,
  );
});

test('原生 Rust host 必须匹配 Node 系统与架构', () => {
  assert.equal(
    verifyNativeHost('x86_64-pc-windows-msvc', 'win32', 'x64'),
    'x86_64-pc-windows-msvc',
  );
  assert.equal(verifyNativeHost('aarch64-apple-darwin', 'darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.throws(() => verifyNativeHost('aarch64-unknown-linux-gnu', 'win32', 'x64'), /不一致/);
  assert.throws(() => verifyNativeHost('x86_64-unknown-linux-gnu', 'linux', 'arm64'), /不一致/);
});
