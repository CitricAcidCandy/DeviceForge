import assert from 'node:assert/strict';
import { copyFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { archiveMembers } from '../cli-smoke-archive.mjs';
import { materializeManifest } from '../../cli/src/plugin-package.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { names, pluginId, providerCapabilities } from '../harmony-device-smoke/deployment.mjs';
import { prepareTool } from '../harmony-device-smoke/fixtures.mjs';

export async function preservePluginArchive(archive, report) {
  assert.ok(archive.endsWith('.tgz'));
  const info = await lstat(archive);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024 * 1024);
  const original = await fileIdentity(archive),
    retainedPath = join(report.directory, basename(archive));
  await copyFile(archive, retainedPath);
  const retained = await fileIdentity(retainedPath);
  assert.equal(retained.sha256, original.sha256);
  assert.equal(retained.bytes, original.bytes);
  report.plugin = {
    archive: original,
    retained_archive: retained,
    members: await archiveMembers(retainedPath, original.sha256),
  };
}

export async function verifyPluginMembers(deployment, report) {
  const original = await fileIdentity(report.plugin.archive.path),
    retained = await fileIdentity(report.plugin.retained_archive.path);
  assert.equal(original.sha256, report.plugin.archive.sha256);
  assert.equal(retained.sha256, original.sha256);
  const members = await archiveMembers(retained.path, original.sha256);
  assert.deepEqual(members, report.plugin.members);
  for (const member of members) {
    const path = join(deployment.packageRoot, ...member.relative_path.split('/'));
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    const actual = await fileIdentity(path);
    assert.equal(actual.bytes, member.bytes, member.relative_path);
    assert.equal(actual.sha256, member.sha256, member.relative_path);
  }
  const generated = await fileIdentity(deployment.manifestPath);
  assert.equal(generated.sha256, report.plugin.generated_manifest.sha256);
  report.plugin.member_verification = {
    matched_files: members.length,
    passed: true,
    checked_at: new Date().toISOString(),
  };
}

export async function inspectInstalled(host, report, source, originalBinary) {
  const platform = `${process.platform}-${process.arch}`,
    packageName = `@deviceforge/plugin-${pluginId}-${platform}`;
  const packageRoot = join(host.plugins, pluginId, 'node_modules', ...packageName.split('/'));
  const descriptor = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(descriptor.name, packageName);
  assert.equal(descriptor.deviceforge.kind, 'server');
  assert.equal(descriptor.deviceforge.manifest, 'plugin.json');
  assert.deepEqual(descriptor.os, [process.platform]);
  assert.deepEqual(descriptor.cpu, [process.arch]);
  const executableName = `deviceforge-${pluginId}-plugin${process.platform === 'win32' ? '.exe' : ''}`;
  assert.deepEqual(descriptor.deviceforge.entrypoints, {
    [platform]: { runtime: 'native', path: `bin/${executableName}` },
  });
  const expectedMembers = [
    'README.md',
    'package.json',
    'plugin.json',
    `bin/${executableName}`,
    'bin/aliases.example.json',
    'bin/harmony-device.config.example.json',
  ].sort();
  assert.deepEqual(
    report.plugin.members.map((member) => member.relative_path).sort(),
    expectedMembers,
  );
  const sourceManifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  delete sourceManifest.executable;
  const manifest = JSON.parse(await readFile(join(packageRoot, 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest, sourceManifest);
  assert.equal(manifest.id, pluginId);
  assert.equal(manifest.version, descriptor.version);
  assert.equal(manifest.protocol_version, 4);
  assert.equal(manifest.devices.api_version, 3);
  assert.deepEqual(manifest.operations.map((item) => item.name).sort(), [...names].sort());
  assert.deepEqual(
    manifest.devices.capabilities.map((item) => item.id).sort(),
    names.filter((name) => name !== 'discover').sort(),
  );
  assert.deepEqual(
    manifest.devices.capabilities
      .filter((item) => item.scope === 'provider')
      .map((item) => item.id)
      .sort(),
    [...providerCapabilities].sort(),
  );
  assert.equal(manifest.devices.capabilities.filter((item) => item.scope === 'device').length, 7);
  for (const name of providerCapabilities)
    assert.deepEqual(
      manifest.devices.capabilities.find((item) => item.id === name),
      {
        id: name,
        version: 1,
        operation: name,
        scope: 'provider',
        access: 'write',
        execution_timeout_ms: 30000,
      },
    );
  const manifestPath = join(host.plugins, pluginId, 'manifest.json');
  const generated = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(generated, await materializeManifest(packageRoot, packageRoot, platform));
  const actualBinary = generated.executable;
  assert.equal(actualBinary, join(packageRoot, 'bin', executableName));
  const sourceBinary = await fileIdentity(originalBinary),
    installedBinary = await fileIdentity(actualBinary);
  assert.equal(installedBinary.bytes, sourceBinary.bytes);
  assert.equal(installedBinary.sha256, sourceBinary.sha256);
  assert.equal(
    (await readFile(join(packageRoot, 'README.md'), 'utf8')).endsWith(
      (await readFile(join(source, 'README.md'), 'utf8')) + '\n',
    ),
    true,
  );
  report.plugin.name = packageName;
  report.plugin.version = manifest.version;
  report.plugin.source_binary = sourceBinary;
  report.plugin.installed_binary = installedBinary;
  report.plugin.generated_manifest = await fileIdentity(manifestPath);
  const deployment = { packageRoot, actualBinary, manifestPath, manifest };
  await verifyPluginMembers(deployment, report);
  return deployment;
}

export async function materializeTemplates(deployment, temporary, toolBinary, source, report) {
  const directory = dirname(deployment.actualBinary);
  for (const name of ['aliases.example.json', 'harmony-device.config.example.json']) {
    assert.deepEqual(
      await readFile(join(directory, name)),
      await readFile(join(source, name)),
      '公开模板原字节须来自当前源码',
    );
  }
  const bindingsPath = join(temporary, 'operation-bindings.json');
  await copyFile(join(directory, 'aliases.example.json'), bindingsPath);
  const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
  assert.equal(bindings.format_version, 2);
  assert.equal(bindings.bindings.length, names.length);
  const fixture = await prepareTool(temporary, toolBinary, report);
  fixture.pluginBinary = deployment.actualBinary;
  const template = JSON.parse(
    await readFile(join(directory, 'harmony-device.config.example.json'), 'utf8'),
  );
  assert.deepEqual(template, { format_version: 1, tools: { hdc: 'hdc' } });
  const configPath = join(directory, 'harmony-device.config.json');
  await assert.rejects(lstat(configPath), { code: 'ENOENT' });
  await writeFile(
    configPath,
    JSON.stringify({
      ...template,
      tools: { ...template.tools, hdc: fixture.copiedTool },
      scratch_root: fixture.scratchRoot,
    }) + '\n',
    { flag: 'wx' },
  );
  report.plugin.configuration = {
    template: await fileIdentity(join(directory, 'harmony-device.config.example.json')),
    materialized: await fileIdentity(configPath),
    bindings_template: await fileIdentity(join(directory, 'aliases.example.json')),
    materialized_bindings: await fileIdentity(bindingsPath),
    scope: '部署者从公开模板生成旁置配置；不改生成清单或包内模板原字节',
  };
  return { fixture, bindingsPath };
}
