import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeManifest } from '../../cli/src/plugin-package.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export const pluginId = 'harmony-device';
export const names = [
  'discover',
  'packages',
  'connect',
  'disconnect',
  'app.install',
  'app.uninstall',
  'app.detail',
  'app.start',
  'app.stop',
  'app.reset',
];
export const providerCapabilities = ['connect', 'disconnect'];
export const alias = (name) => (name === 'discover' ? 'harmony.devices' : `harmony.${name}`);
export const operation = (name) => `plugin.${pluginId}.${name}`;
export const oldNames = [...names.flatMap((name) => [alias(name), operation(name)])];

export async function prepareDeployment({
  root,
  directory,
  profile,
  report,
  source = join(root, 'backend/plugins/harmony-device'),
}) {
  const files = ['manifest.json', 'manifest.example.json', 'aliases.example.json', 'README.md'];
  const bytes = await Promise.all(files.map((name) => readFile(join(source, name))));
  const [manifest, example, bindings] = bytes.slice(0, 3).map((value) => JSON.parse(value));
  assert.deepEqual(bytes[0], bytes[1], 'Harmony双manifest必须原字节相同');
  assert.deepEqual(manifest, example);
  assert.equal(manifest.id, pluginId);
  assert.equal(manifest.protocol_version, 4);
  assert.equal(manifest.devices.api_version, 3);
  assert.equal(manifest.devices.platform, 'harmony');
  assert.deepEqual(manifest.args, []);
  assert.deepEqual(manifest.operations.map((entry) => entry.name).sort(), [...names].sort());
  assert.equal(manifest.devices.capabilities.length, 9);
  assert.deepEqual(manifest.artifacts, {
    input_fields: [],
    input_pointers: ['/input/artifact_id'],
    outputs: false,
  });
  assert.equal(bindings.format_version, 2);
  assert.equal(bindings.bindings.length, names.length);
  assert.equal(manifest.devices.discover_operation, 'discover');
  for (const name of names) {
    const matching = bindings.bindings.filter((row) => row.operation.id === alias(name));
    assert.equal(matching.length, 1);
    const binding = matching[0];
    assert.equal(binding.input, name === 'discover' ? 'identity' : 'device_envelope');
    assert.deepEqual(
      binding.target,
      name === 'discover'
        ? { kind: 'device_discovery', plugin_id: pluginId }
        : { kind: 'device_capability', plugin_id: pluginId, capability: name, version: 1 },
    );
    if (name === 'discover')
      assert.deepEqual(binding.result, { kind: 'device_discovery', platform: 'harmony' });
    else {
      assert.deepEqual(binding.result, { kind: 'value', wrapped: true });
      assert.deepEqual(
        manifest.devices.capabilities.find((row) => row.id === name),
        {
          id: name,
          version: 1,
          operation: name,
          scope: providerCapabilities.includes(name) ? 'provider' : 'device',
          access: name === 'packages' || name === 'app.detail' ? 'read' : 'write',
          execution_timeout_ms: name === 'app.install' || name === 'app.uninstall' ? 120000 : 30000,
        },
      );
    }
  }

  const platform = `${process.platform}-${process.arch}`;
  const executableName = `deviceforge-${pluginId}-plugin${process.platform === 'win32' ? '.exe' : ''}`;
  const binary = join(root, 'backend/target', profile, executableName);
  const packageRoot = join(directory, 'portable-staging'),
    portableRoot = join(packageRoot, 'portable');
  const publishedRoot = join(directory, 'data/server-plugins', pluginId);
  await mkdir(join(portableRoot, 'bin'), { recursive: true });
  await copyFile(binary, join(portableRoot, 'bin', executableName));
  await writeFile(join(portableRoot, 'manifest.json'), bytes[0], { flag: 'wx' });
  await writeFile(join(portableRoot, 'manifest.example.json'), bytes[1], { flag: 'wx' });
  await writeFile(join(portableRoot, 'aliases.example.json'), bytes[2], { flag: 'wx' });
  await writeFile(join(portableRoot, 'README.md'), bytes[3], { flag: 'wx' });
  await writeFile(
    join(portableRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@deviceforge/harmony-device',
        version: manifest.version,
        deviceforge: {
          kind: 'server',
          manifest: 'manifest.json',
          entrypoints: { [platform]: { runtime: 'native', path: `bin/${executableName}` } },
        },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  const generated = await materializeManifest(
    portableRoot,
    join(publishedRoot, 'portable'),
    platform,
  );
  await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(generated, null, 2) + '\n', {
    flag: 'wx',
  });
  const bindingsPath = join(directory, 'operation-bindings.json');
  await writeFile(bindingsPath, bytes[2], { flag: 'wx' });
  const actualBinary = join(publishedRoot, 'portable', 'bin', executableName);
  report.deployment = {
    kind: '源便携目录+真实Harmony binary+公开load；非在线TGZ安装或npx',
    plugin_id: pluginId,
    profile,
    platform,
    protocol_version: 4,
    device_api_version: 3,
    original_plugin_binary: await fileIdentity(binary),
    published_root: publishedRoot,
    generated_manifest: await fileIdentity(join(packageRoot, 'manifest.json')),
    source_identities: await Promise.all(files.map((name) => fileIdentity(join(source, name)))),
  };
  const validator = join(
    root,
    'backend/target',
    profile,
    'validate-plugin' + (process.platform === 'win32' ? '.exe' : ''),
  );
  report.deployment.validator_binary = await fileIdentity(validator);
  return {
    publishedRoot,
    actualBinary,
    manifest,
    bindingsPath,
    binary,
    source,
    packageRoot,
    validator,
  };
}

export async function publishAndValidate(deployment, report) {
  await rename(deployment.packageRoot, deployment.publishedRoot);
  report.deployment.actual_plugin_binary = await fileIdentity(deployment.actualBinary);
  assert.equal(
    report.deployment.original_plugin_binary.sha256,
    report.deployment.actual_plugin_binary.sha256,
  );
  report.deployment.generated_manifest = await fileIdentity(
    join(deployment.publishedRoot, 'manifest.json'),
  );
  await assert.rejects(
    lstat(join(deployment.publishedRoot, 'portable/bin/harmony-device.config.json')),
    { code: 'ENOENT' },
  );
  await new Promise((done, reject) => {
    const child = execFile(
      deployment.validator,
      [join(deployment.publishedRoot, 'manifest.json')],
      { timeout: 15000, maxBuffer: 65536, windowsHide: true },
      (error, stdout, stderr) => {
        report.validator = {
          pid: child.pid,
          exit_code: child.exitCode,
          signal: child.signalCode,
          error_name: error?.name,
          error_code: error?.code,
        };
        if (error) {
          reject(error);
          return;
        }
        try {
          assert.equal(child.exitCode, 0);
          assert.equal(child.signalCode, null);
          assert.equal(stderr.trim(), '');
          assert.deepEqual(JSON.parse(stdout), {
            id: pluginId,
            version: deployment.manifest.version,
            operations: names.length,
          });
          report.validator.result = JSON.parse(stdout);
          done();
        } catch (failure) {
          reject(failure);
        }
      },
    );
  });
  report.checks.push({
    name: '当前原binary、源双manifest及真实validator exit0/十贡献九定义能力',
    passed: true,
  });
}
export async function verifyDeployment(deployment, report) {
  const after = await fileIdentity(deployment.actualBinary);
  assert.equal(after.sha256, report.deployment.original_plugin_binary.sha256);
  const manifest = await fileIdentity(join(deployment.publishedRoot, 'manifest.json'));
  assert.equal(manifest.sha256, report.deployment.generated_manifest.sha256);
  report.deployment.actual_binary_after = after;
  report.deployment.generated_manifest_after = manifest;
}
