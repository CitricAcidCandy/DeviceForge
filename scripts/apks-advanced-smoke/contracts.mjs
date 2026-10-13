import assert from 'node:assert/strict';
import { apkSample, sha256, storedZip } from '../android-packages-smoke/samples.mjs';

export { sha256 };
export const serial = '模拟:甲';
export const extractOperation = 'plugin.android-packages.extract_splits';
export const installOperation = 'plugin.android-device.app.install_apks';
export const baseApk = apkSample('advanced-base');
export const featureApk = apkSample('advanced-feature');
export const apks = storedZip([['toc.pb', Buffer.from([8, 1])], ['splits/base-master.apk', baseApk],
  ['splits/feature_1.apk', featureApk]]);
export const invalidApks = storedZip([['splits/base-master.apk', baseApk]]);
export const basicSpec = { supported_abis: ['arm64-v8a'], supported_locales: ['zh-CN'], screen_density: 480, sdk_version: 35 };
export const advancedSpec = { ...basicSpec, device_features: ['android.hardware.camera', 'feature:public'],
  gl_extensions: ['GL_EXT_texture_compression_astc'], codename: 'REL', device_tier: 'tier_2' };
export const basicPrivate = '{"screenDensity":480,"sdkVersion":35,"supportedAbis":["arm64-v8a"],"supportedLocales":["zh-CN"]}';
export const advancedPrivate = '{"codename":"REL","deviceFeatures":["android.hardware.camera","feature:public"],"deviceTier":"tier_2","glExtensions":["GL_EXT_texture_compression_astc"],"screenDensity":480,"sdkVersion":35,"supportedAbis":["arm64-v8a"],"supportedLocales":["zh-CN"]}';
export const apkEntries = ['base-master.apk', 'features/feature_1.apk'];

export function sourceContract(packages, device, aliases) {
  assert.equal(packages.protocol_version, 4);
  assert.equal(packages.operations.length, 7);
  const extraction = packages.operations.find(value => value.name === 'extract_splits');
  assert.ok(extraction);
  assert.deepEqual(extraction.execution, { api_version: 1, total_timeout_ms: 120000 });
  assert.deepEqual(Object.keys(extraction.input_schema.properties).sort(), ['artifact_id', 'device_spec', 'instant', 'modules']);
  assert.deepEqual(Object.keys(extraction.input_schema.properties.device_spec.properties).sort(),
    ['codename', 'device_features', 'device_tier', 'gl_extensions', 'screen_density', 'sdk_version', 'supported_abis', 'supported_locales']);
  assert.equal(device.protocol_version, 4);
  assert.equal(device.operations.length, 12);
  assert.equal(device.devices.api_version, 3);
  const capability = device.devices.capabilities.find(value => value.id === 'app.install_apks');
  assert.equal(capability.version, 1);
  assert.equal(capability.execution_timeout_ms, 120000);
  const installation = device.operations.find(value => value.name === 'app.install_apks');
  assert.deepEqual(Object.keys(installation.input_schema.properties).sort(), ['device_id', 'input']);
  assert.deepEqual(Object.keys(installation.input_schema.properties.input.properties).sort(), ['artifact_id', 'modules']);
  const legacy = aliases.bindings.find(value => value.operation.id === 'android.package.extract_splits');
  assert.deepEqual(Object.keys(legacy.operation.input_schema.properties).sort(), ['artifact_id', 'device_spec']);
  assert.deepEqual(Object.keys(legacy.operation.input_schema.properties.device_spec.properties).sort(),
    ['screen_density', 'sdk_version', 'supported_abis', 'supported_locales']);
}
