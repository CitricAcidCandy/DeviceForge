import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeManifest } from '../../cli/src/plugin-package.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { assertSourceContract, names, pluginId } from './contracts.mjs';

export async function prepareDeployment({ root, directory, profile, report }) {
  const source = join(root, 'backend/plugins/harmony-device');
  const files = ['manifest.json', 'manifest.example.json', 'aliases.example.json', 'README.md'];
  const bytes = await Promise.all(files.map((name) => readFile(join(source, name))));
  const [manifest, example, bindings] = bytes.slice(0, 3).map((value) => JSON.parse(value));
  assert.deepEqual(bytes[0], bytes[1]); assertSourceContract(manifest, example, bindings);
  const platform = process.platform + '-' + process.arch;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const executableName = 'deviceforge-' + pluginId + '-plugin' + suffix;
  const binary = join(root, 'backend/target', profile, executableName);
  const packageRoot = join(directory, 'portable-staging'), portableRoot = join(packageRoot, 'portable');
  const publishedRoot = join(directory, 'data/server-plugins', pluginId);
  await mkdir(join(portableRoot, 'bin'), { recursive: true });
  await copyFile(binary, join(portableRoot, 'bin', executableName));
  for (let index = 0; index < files.length; index++) await writeFile(join(portableRoot, files[index]), bytes[index], { flag: 'wx' });
  await writeFile(join(portableRoot, 'package.json'), JSON.stringify({ name: '@deviceforge/harmony-device', version: manifest.version,
    deviceforge: { kind: 'server', manifest: 'manifest.json', entrypoints: {
      [platform]: { runtime: 'native', path: 'bin/' + executableName } } } }, null, 2) + '\n', { flag: 'wx' });
  const generated = await materializeManifest(portableRoot, join(publishedRoot, 'portable'), platform);
  await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(generated, null, 2) + '\n', { flag: 'wx' });
  const bindingsPath = join(directory, 'operation-bindings.json'); await writeFile(bindingsPath, bytes[2], { flag: 'wx' });
  const actualBinary = join(publishedRoot, 'portable/bin', executableName);
  const validator = join(root, 'backend/target', profile, 'validate-plugin' + suffix);
  report.deployment = { kind: '冻结输入、当前原程序与便携副本，正式TGZ和npx另验', profile, platform,
    original_plugin_binary: await fileIdentity(binary), validator_binary: await fileIdentity(validator),
    source_identities: await Promise.all(files.map((name) => fileIdentity(join(source, name)))) };
  return { publishedRoot, actualBinary, manifest, bindingsPath, binary, source, packageRoot, validator };
}

export async function publishAndValidate(deployment, report) {
  await rename(deployment.packageRoot, deployment.publishedRoot);
  report.deployment.actual_plugin_binary = await fileIdentity(deployment.actualBinary);
  assert.equal(report.deployment.original_plugin_binary.sha256, report.deployment.actual_plugin_binary.sha256);
  report.deployment.generated_manifest = await fileIdentity(join(deployment.publishedRoot, 'manifest.json'));
  await assert.rejects(lstat(join(deployment.publishedRoot, 'portable/bin/harmony-device.config.json')), { code: 'ENOENT' });
  await new Promise((done, reject) => {
    const child = execFile(deployment.validator, [join(deployment.publishedRoot, 'manifest.json')],
      { timeout: 15000, maxBuffer: 65536, windowsHide: true }, (error, stdout, stderr) => {
        report.validator = { pid: child.pid, exit_code: child.exitCode, signal: child.signalCode, error_code: error?.code };
        if (error) { reject(error); return; }
        try {
          assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null); assert.equal(stderr.trim(), '');
          assert.deepEqual(JSON.parse(stdout), { id: pluginId, version: deployment.manifest.version, operations: names.length });
          done();
        } catch (failure) { reject(failure); }
      });
  });
  report.checks.push({ name: '冻结双清单、十二贡献十一能力及实际validator退出零', passed: true });
}

export async function verifyDeployment(deployment, report) {
  const after = await fileIdentity(deployment.actualBinary); assert.equal(after.sha256, report.deployment.original_plugin_binary.sha256);
  const manifest = await fileIdentity(join(deployment.publishedRoot, 'manifest.json'));
  assert.equal(manifest.sha256, report.deployment.generated_manifest.sha256);
  report.deployment.actual_binary_after = after; report.deployment.generated_manifest_after = manifest;
}
