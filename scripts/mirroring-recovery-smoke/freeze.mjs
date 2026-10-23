import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity } from './evidence.mjs';

export async function freezeInputs(options, directory, report) {
  const snapshot = join(directory, 'snapshot');
  await mkdir(snapshot);
  const files = {
    'apk-server.exe': join(options.hostDirectory, 'apk-server.exe'),
    'deviceforge-mirroring-plugin.exe': join(options.pluginDirectory, 'deviceforge-mirroring-plugin.exe'),
    'manifest.json': join(options.pluginDirectory, 'manifest.json'),
    'fake-adb.exe': options.tool, 'process-probe.exe': options.probe,
    ...(options.leaseTool ? { 'lease-holder.exe': options.leaseTool } : {}),
  };
  report.inputs = [];
  assert.equal(new Set(Object.values(files).map((path) => resolve(path).toLowerCase())).size, Object.keys(files).length,
    '宿主、插件、清单、假工具与探针不得混用同一个输入');
  for (const [name, path] of Object.entries(files)) {
    const before = await fileIdentity(path), destination = join(snapshot, name);
    await copyFile(path, destination);
    const actual = await fileIdentity(destination);
    assert.equal(actual.sha256, before.sha256);
    report.inputs.push({ before, actual });
  }
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'mirroring');
  assert.equal(manifest.protocol_version, 4);
  assert.equal(manifest.sessions?.protocol_version, 5);
  assert.ok(manifest.sessions.operations.some((operation) => operation.name === 'open'));
  assert.deepEqual(manifest.recovery, { api_version: 1, operation: 'runtime.recover', timeout_ms: 30000 },
    '必须使用主代理完成恢复声明的新插件清单，不自动替生产输入补声明');
  report.manifest_contract = { id: manifest.id, protocol_version: manifest.protocol_version,
    sessions_protocol_version: manifest.sessions.protocol_version, recovery: manifest.recovery };
  return { snapshot, manifest };
}

export async function driverIdentities(entry) {
  const visited = new Set(), identities = [];
  const visit = async (path) => {
    path = resolve(path);
    if (visited.has(path)) return;
    visited.add(path);
    const identity = await fileIdentity(path);
    identities.push(identity);
    const source = await readFile(path, 'utf8');
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g);
    for (const [, specifier] of imports) await visit(resolve(dirname(path), specifier));
  };
  await visit(entry);
  for (const url of [
    './fake-adb.rs', './fake-contract.rs', './lease-holder.rs', './lease-launcher.mjs', './fault-worker.mjs', './browser-provider-worker.mjs', './README.md', './self-test.mjs',
    '../mirroring-webrtc-smoke/socket_server.rs', '../harmony-screenshot-smoke/process-probe.rs',
  ]) {
    const path = fileURLToPath(new URL(url, import.meta.url));
    if (!visited.has(path)) { visited.add(path); identities.push(await fileIdentity(path)); }
  }
  return identities;
}

export async function verifyFrozenInputs(report) {
  for (const entry of report.inputs ?? []) {
    entry.after = await fileIdentity(entry.before.path);
    assert.deepEqual(entry.after, entry.before, '原始冻结输入发生变化');
    assert.deepEqual(await fileIdentity(entry.actual.path), entry.actual, '独占快照发生变化');
  }
  for (const before of report.driver_inputs ?? [])
    assert.deepEqual(await fileIdentity(before.path), before, '受检驱动或导入辅助模块发生变化');
}
