import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { materializeManifest } from '../../cli/src/plugin-package.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { xml } from './samples.mjs';

export const suffixes = [
  'manifest',
  'signature',
  'extract_apk',
  'build_apks',
  'decode',
  'scan_sdks',
  'extract_splits',
];

export async function prepareDeployment({ root, directory, pluginBinary, toolBinary, report }) {
  const source = join(root, 'backend/plugins/android-packages');
  const [descriptorBytes, manifestBytes, exampleBytes, aliasBytes] = await Promise.all(
    ['package.json', 'manifest.json', 'manifest.example.json', 'aliases.example.json'].map((name) =>
      readFile(join(source, name)),
    ),
  );
  const descriptor = JSON.parse(descriptorBytes),
    manifest = JSON.parse(manifestBytes),
    example = JSON.parse(exampleBytes);
  assert.deepEqual(manifest, example, '双清单必须逐字段相同');
  assert.equal(manifest.id, 'android-packages');
  assert.equal(manifest.protocol_version, 4);
  assert.deepEqual(manifest.args, []);
  assert.deepEqual(
    manifest.operations.map((item) => item.name),
    suffixes,
  );
  assert.deepEqual(manifest.artifacts, {
    input_fields: ['artifact_id'],
    input_pointers: [],
    outputs: true,
  });
  const aliases = JSON.parse(aliasBytes);
  assert.equal(aliases.format_version, 1);
  assert.equal(aliases.bindings.length, 7);
  for (const [index, binding] of aliases.bindings.entries()) {
    const name = suffixes[index];
    assert.equal(binding.operation.id, `android.package.${name}`);
    assert.deepEqual(binding.target, {
      kind: 'operation',
      plugin_id: manifest.id,
      operation: `plugin.android-packages.${name}`,
    });
    assert.equal(binding.input, 'identity');
    assert.equal(binding.result.wrapped, true);
    assert.deepEqual(binding.operation.input_schema, manifest.operations[index].input_schema);
  }
  const platform = `${process.platform}-${process.arch}`;
  const entry = descriptor.deviceforge.entrypoints[platform];
  assert.ok(entry && entry.runtime === 'native', '必须使用包已声明的真实原生平台');
  assert.equal(
    entry.path,
    `bin/deviceforge-android-packages-plugin${process.platform === 'win32' ? '.exe' : ''}`,
  );
  assert.equal(descriptor.deviceforge.manifest, 'manifest.json');
  const packageRoot = join(directory, 'portable-staging');
  const publishedRoot = join(directory, 'data/server-plugins/android-packages');
  const portableRoot = join(packageRoot, 'portable');
  const toolRoot = join(directory, 'tool');
  const scratch = join(directory, 'scratch');
  const observations = join(toolRoot, 'observations');
  await Promise.all([
    mkdir(join(portableRoot, 'bin'), { recursive: true }),
    mkdir(observations, { recursive: true }),
    mkdir(scratch),
  ]);
  const copiedPlugin = join(portableRoot, entry.path),
    copiedTool = join(
      toolRoot,
      process.platform === 'win32' ? 'manifest-tool.exe' : 'manifest-tool',
    );
  await Promise.all([copyFile(pluginBinary, copiedPlugin), copyFile(toolBinary, copiedTool)]);
  await writeFile(join(toolRoot, 'manifest.xml'), xml, 'utf8');
  const stagedConfig = join(packageRoot, 'android-packages.config.json');
  const configPath = join(publishedRoot, 'android-packages.config.json');
  const config = {
    format_version: 1,
    tools: { apkanalyzer: { kind: 'executable', executable: copiedTool } },
    scratch_root: scratch,
  };
  await writeFile(stagedConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const portable = { ...manifest, args: ['--config', resolve(configPath)] };
  await writeFile(join(portableRoot, 'package.json'), descriptorBytes);
  await writeFile(
    join(portableRoot, 'manifest.json'),
    `${JSON.stringify(portable, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(portableRoot, 'manifest.example.json'), exampleBytes);
  await writeFile(join(portableRoot, 'README.md'), await readFile(join(source, 'README.md')));
  const publishedPortable = join(publishedRoot, 'portable');
  const materialized = await materializeManifest(portableRoot, publishedPortable, platform);
  assert.equal(materialized.executable, join(publishedPortable, entry.path));
  assert.deepEqual(materialized.args, ['--config', resolve(configPath)]);
  await writeFile(
    join(packageRoot, 'manifest.json'),
    `${JSON.stringify(materialized, null, 2)}\n`,
    'utf8',
  );
  const bindingsPath = join(directory, 'operation-bindings.json');
  await writeFile(bindingsPath, aliasBytes);
  const identityPaths = [
    pluginBinary,
    toolBinary,
    ...['package.json', 'manifest.json', 'manifest.example.json', 'aliases.example.json'].map(
      (name) => join(source, name),
    ),
    copiedPlugin,
    copiedTool,
    stagedConfig,
    bindingsPath,
    join(packageRoot, 'manifest.json'),
    join(portableRoot, 'manifest.json'),
    join(toolRoot, 'manifest.xml'),
  ];
  const identities = await Promise.all(identityPaths.map(fileIdentity));
  assert.equal(identities[0].sha256, identities[6].sha256);
  assert.equal(identities[1].sha256, identities[7].sha256);
  report.deployment = {
    kind: '本次便携目录+CLI materializeManifest+真实宿主load；非在线TGZ或CLI install/npx',
    plugin_id: manifest.id,
    protocol_version: 4,
    platform,
    package_root: packageRoot,
    config_path: configPath,
    bindings_path: bindingsPath,
    identities,
    short_contributions: suffixes,
    config_scope: '本次绝对假工具路径与独占scratch，不配置真实签名材料',
    original_manifests_equal: true,
    portable_args_override: true,
  };
  return {
    packageRoot,
    publishedRoot,
    copiedPlugin,
    copiedTool,
    configPath,
    bindingsPath,
    scratch,
    observations,
    toolRoot,
    identities,
    aliases,
  };
}

export async function publishDeployment(deployment, report) {
  await rename(deployment.packageRoot, deployment.publishedRoot);
  const beforeRoot = `${deployment.packageRoot}/`.replaceAll('\\', '/');
  deployment.identities = deployment.identities.map((identity) => {
    const path = identity.path.replaceAll('\\', '/');
    return path.startsWith(beforeRoot)
      ? { ...identity, path: join(deployment.publishedRoot, path.slice(beforeRoot.length)) }
      : identity;
  });
  deployment.copiedPlugin = join(
    deployment.publishedRoot,
    'portable/bin',
    `deviceforge-android-packages-plugin${process.platform === 'win32' ? '.exe' : ''}`,
  );
  report.deployment.published_root = deployment.publishedRoot;
  report.deployment.published_identities = deployment.identities;
}

export async function verifyDeploymentIdentity(deployment, report) {
  report.deployment.identities_after = [];
  for (const before of deployment.identities) {
    const after = await fileIdentity(before.path);
    assert.equal(after.bytes, before.bytes);
    assert.equal(after.sha256, before.sha256);
    report.deployment.identities_after.push(after);
  }
}
