import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeManifest } from '../../cli/src/plugin-package.mjs';
import { digest } from '../unified-discovery-browser/lifecycle.mjs';
import { capabilityNames, pluginId } from './fixtures.mjs';

const executableName = process.platform === 'win32' ? 'deviceforge-android-device-plugin.exe' : 'deviceforge-android-device-plugin';
const toolName = process.platform === 'win32' ? 'device-tool.exe' : 'device-tool';

export async function prepareDeployment({ root, directory, profile, toolBinary, report, source = join(root, 'backend/plugins/android-device') }) {
  const sourceManifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const binary = join(root, 'backend/target', profile, executableName);
  assert.equal(sourceManifest.id, pluginId); assert.equal(sourceManifest.protocol_version, 4);
  assert.equal(sourceManifest.devices.api_version, 3); assert.equal(sourceManifest.devices.platform, 'android');
  assert.equal(sourceManifest.devices.discover_operation, 'discover');
  assert.deepEqual(sourceManifest.operations.map((item) => item.name).sort(), ['discover', ...capabilityNames].sort());
  assert.equal(sourceManifest.devices.capabilities.length, 9);
  assert.deepEqual(sourceManifest.devices.capabilities.map((item) => item.id), capabilityNames);
  assert.deepEqual(sourceManifest.artifacts, { input_fields: [], input_pointers: ['/input/artifact_id'], outputs: true });
  assert.equal(packageJson.deviceforge.entrypoints[`${process.platform}-${process.arch}`].path, `bin/${executableName}`);
  const published = join(directory, 'data', 'server-plugins', pluginId);
  const portable = join(published, 'portable');
  await mkdir(join(portable, 'bin'), { recursive: true });
  await copyFile(binary, join(portable, 'bin', executableName));
  await copyFile(toolBinary, join(portable, 'bin', toolName));
  for (const name of ['package.json', 'manifest.json', 'README.md']) await copyFile(join(source, name), join(portable, name));
  const configPath = join(portable, 'bin', 'android-device.config.json');
  await mkdir(join(directory, 'scratch'), { recursive: true });
  await writeFile(configPath, JSON.stringify({ format_version: 1, tools: { adb: join(portable, 'bin', toolName) }, scratch_root: join(directory, 'scratch') }) + '\n', { flag: 'wx' });
  const generated = await materializeManifest(portable, portable, `${process.platform}-${process.arch}`);
  await writeFile(join(published, 'manifest.json'), JSON.stringify(generated, null, 2) + '\n', { flag: 'wx' });
  report.deployment = { pluginId, profile, source: '实际插件元数据+materializeManifest+复制的tool binary', binary: await digest(binary), tool: await digest(toolBinary), generated: generated.id, configPath };
  report.deployment.files_before = await Promise.all([join(published, 'manifest.json'), configPath,
    join(portable, 'package.json'), join(portable, 'manifest.json')].map(async (path) => ({ path, ...await digest(path) })));
  return { sourceManifest, binary, toolBinary, portable, published, generated, configPath, actualBinary: join(portable, 'bin', executableName), toolCopy: join(portable, 'bin', toolName) };
}

export async function verifyDeployment(deployment, report) {
  assert.deepEqual(await digest(deployment.actualBinary), report.deployment.binary);
  assert.deepEqual(await digest(deployment.toolCopy), report.deployment.tool);
  report.deployment.identityAfter = { binary: await digest(deployment.actualBinary), tool: await digest(deployment.toolCopy) };
  report.deployment.files_after = await Promise.all(report.deployment.files_before.map(async ({ path }) => ({ path, ...await digest(path) })));
  assert.deepEqual(report.deployment.files_after, report.deployment.files_before);
}
