import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeManifest } from '../../cli/src/plugin-package.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export const pluginId = 'android-device';
export const names = ['discover', 'connect', 'disconnect', 'packages', 'app.start', 'app.stop', 'app.uninstall', 'input'];
export const alias = (name) => name === 'discover' ? 'android.devices' : `android.${name}`;
export const operation = (name) => `plugin.${pluginId}.${name}`;

export async function prepareDeployment({ root, directory, profile, report }) {
  const source = join(root, 'backend/plugins/android-device');
  const files = ['package.json', 'manifest.json', 'manifest.example.json', 'aliases.example.json'];
  const bytes = await Promise.all(files.map((name) => readFile(join(source, name))));
  const [descriptor, manifest, example, bindings] = bytes.map((value) => JSON.parse(value));
  assert.deepEqual(bytes[1], bytes[2], '源双清单必须原字节相同'); assert.deepEqual(manifest, example);
  assert.equal(manifest.id, pluginId); assert.equal(manifest.protocol_version, 4);
  assert.equal(manifest.devices.api_version, 3); assert.equal(manifest.devices.platform, 'android');
  assert.equal(manifest.devices.discover_operation, 'discover'); assert.deepEqual(manifest.args, []);
  assert.deepEqual(manifest.operations.map((entry) => entry.name), names);
  assert.ok(manifest.operations.every((entry) => entry.execution === undefined));
  assert.equal(manifest.devices.capabilities.length, 7);
  assert.equal(bindings.format_version, 2); assert.equal(bindings.bindings.length, 8);
  for (const [index, name] of names.entries()) {
    const binding = bindings.bindings[index]; assert.equal(binding.operation.id, alias(name));
    assert.equal(binding.input, index === 0 ? 'identity' : 'device_envelope');
    assert.deepEqual(binding.target, index === 0 ? { kind: 'device_discovery', plugin_id: pluginId }
      : { kind: 'device_capability', plugin_id: pluginId, capability: name, version: 1 });
    if (index > 0) {
      const capability = manifest.devices.capabilities[index - 1];
      assert.equal(capability.id, name); assert.equal(capability.operation, name);
      assert.equal(capability.execution_timeout_ms, name === 'app.uninstall' ? 120000 : 30000);
    }
  }
  const platform = `${process.platform}-${process.arch}`, entry = descriptor.deviceforge.entrypoints[platform];
  assert.deepEqual(entry, { runtime: 'native', path: `bin/deviceforge-android-device-plugin${process.platform === 'win32' ? '.exe' : ''}` });
  assert.equal(descriptor.deviceforge.manifest, 'manifest.json');
  const binary = join(root, 'backend/target', profile, `deviceforge-android-device-plugin${process.platform === 'win32' ? '.exe' : ''}`);
  const validator = join(root, 'backend/target', profile, `validate-plugin${process.platform === 'win32' ? '.exe' : ''}`);
  const packageRoot = join(directory, 'portable-staging'), portableRoot = join(packageRoot, 'portable');
  const publishedRoot = join(directory, 'data/server-plugins', pluginId);
  await mkdir(join(portableRoot, 'bin'), { recursive: true });
  await copyFile(binary, join(portableRoot, entry.path));
  for (const [index, name] of files.entries()) await writeFile(join(portableRoot, name), bytes[index], { flag: 'wx' });
  await copyFile(join(source, 'README.md'), join(portableRoot, 'README.md'));
  const generated = await materializeManifest(portableRoot, join(publishedRoot, 'portable'), platform);
  // 真实宿主catalog读取deployment/manifest.json，不写同层plugin.json替代。
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(generated, null, 2)}\n`, { flag: 'wx' });
  const bindingsPath = join(directory, 'operation-bindings.json'); await writeFile(bindingsPath, bytes[3], { flag: 'wx' });
  report.deployment = { kind: '源便携目录+真实binary+CLI materializeManifest+validator+公开load；非在线TGZ安装或npx',
    plugin_id: pluginId, profile, platform, protocol_version: 4, device_api_version: 3,
    original_plugin_binary: await fileIdentity(binary), validator_binary: await fileIdentity(validator),
    source_identities: await Promise.all(files.map((name) => fileIdentity(join(source, name)))),
    manifest_name: 'manifest.json', config_injected: false, published_root: publishedRoot };
  return { packageRoot, publishedRoot, manifest, bindingsPath, validator, binary, entry, source };
}

export async function publishAndValidate(deployment, report) {
  await rename(deployment.packageRoot, deployment.publishedRoot);
  const generatedPath = join(deployment.publishedRoot, 'manifest.json');
  const actualBinary = join(deployment.publishedRoot, 'portable', deployment.entry.path);
  report.deployment.actual_plugin_binary = await fileIdentity(actualBinary);
  assert.equal(report.deployment.actual_plugin_binary.sha256, report.deployment.original_plugin_binary.sha256);
  report.deployment.generated_manifest = await fileIdentity(generatedPath);
  for (const folder of [deployment.publishedRoot, join(deployment.publishedRoot, 'portable'), join(deployment.publishedRoot, 'portable/bin')]) {
    await assert.rejects(lstat(join(folder, 'android-device.config.json')), { code: 'ENOENT' });
  }
  await new Promise((done, reject) => {
    const child = execFile(deployment.validator, [generatedPath], { timeout: 15000, maxBuffer: 65536, windowsHide: true },
      (error, stdout, stderr) => {
        report.validator = { pid: child.pid, exit_code: child.exitCode, signal: child.signalCode,
          error_name: error?.name, error_code: error?.code, binary: report.deployment.validator_binary };
        if (error) { reject(error); return; }
        try {
          assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null); assert.equal(stderr.trim(), '');
          assert.deepEqual(JSON.parse(stdout), { id: pluginId, version: deployment.manifest.version, operations: 8 });
          report.validator.result = JSON.parse(stdout); done();
        } catch (assertion) { reject(assertion); }
      });
  });
  report.checks.push({ name: '当前原portable binary、双清单、生成manifest.json及真实validator exit0/八贡献', passed: true });
}
