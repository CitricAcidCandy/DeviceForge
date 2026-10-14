import assert from 'node:assert/strict';
import { join } from 'node:path';
import { regularFile } from '../cli/src/paths.mjs';

export const runtimeFeatureKey = 'npx-runtime';
export const runtimeModuleIds = ['fixture-runtime-first', 'fixture-runtime-second'];

function liveSource(value) {
  assert.equal(value.manifest_source, 'live');
  assert.equal(value.source_error, null);
  assert.equal(typeof value.manifest_sha256, 'string');
  assert.match(value.manifest_sha256, /^[0-9a-f]{64}$/);
  return {
    manifest_source: value.manifest_source,
    manifest_sha256: value.manifest_sha256,
    source_error: null,
  };
}

export async function verifyRuntimeFeatureNpx({
  client,
  installRoot,
  checksum,
  bytes,
  entryBytes,
  sourceCalls,
  bytesAt,
  absent,
  identity,
}) {
  const sourceStart = sourceCalls.length;
  const prefix = 'plugin.tool-supply.runtime_feature.';
  const input = { feature_key: runtimeFeatureKey };
  for (const moduleId of runtimeModuleIds)
    assert.equal(await absent(join(installRoot, moduleId)), true);
  const callsBeforeUnknown = sourceCalls.length;
  const unknown = await client.run(prefix + 'status', { feature_key: 'npx-unknown' }, 'mcp');
  assert.equal(
    sourceCalls.slice(callsBeforeUnknown).filter((call) => call.kind === 'catalog').length,
    1,
  );
  assert.deepEqual(unknown, {
    ...liveSource(unknown),
    feature_key: 'npx-unknown',
    manifest_version: 'fixture-1.0.0',
    source_error: null,
    found: false,
    ready: false,
    modules: [],
  });
  const beforeCalls = sourceCalls.length;
  const before = await client.run(prefix + 'status', input);
  const beforeSourceCalls = sourceCalls.slice(beforeCalls);
  assert.equal(beforeSourceCalls.filter((call) => call.kind === 'catalog').length, 1);
  assert.equal(before.feature_key, runtimeFeatureKey);
  assert.equal(before.manifest_version, 'fixture-1.0.0');
  assert.equal(before.source_error, null);
  assert.deepEqual(liveSource(before), liveSource(unknown));
  assert.equal(before.found, true);
  assert.equal(before.ready, false);
  assert.deepEqual(
    before.modules.map((module) => module.module_id),
    runtimeModuleIds,
  );
  for (const module of before.modules) {
    assert.equal(module.kind, 'runtime');
    assert.equal(module.feature_key, runtimeFeatureKey);
    assert.equal(module.available_version, '1.0.0');
    assert.equal(module.entry_present, false);
    assert.equal(module.action, 'install');
    assert.equal(module.installed_version, null);
    assert.equal(module.required, false);
    assert.equal(module.size, bytes);
  }
  const callsBeforePrepare = sourceCalls.length;
  const prepared = await client.run(prefix + 'prepare', input, 'mcp');
  const preparationCalls = sourceCalls.slice(callsBeforePrepare);
  assert.equal(preparationCalls.filter((call) => call.kind === 'catalog').length, 1);
  assert.equal(
    preparationCalls.filter((call) => call.kind === 'archive').length,
    runtimeModuleIds.length,
  );
  assert.deepEqual(liveSource(prepared), liveSource(unknown));
  assert.deepEqual(prepared, {
    ...liveSource(prepared),
    feature_key: runtimeFeatureKey,
    manifest_version: 'fixture-1.0.0',
    ready: true,
    modules: runtimeModuleIds.map((moduleId) => ({
      module_id: moduleId,
      version: '1.0.0',
      sha256: checksum,
      changed: true,
    })),
  });
  const installed = [];
  for (const moduleId of runtimeModuleIds) {
    const target = join(installRoot, moduleId);
    const entry = await bytesAt(await regularFile(target, 'entry.txt'));
    assert.deepEqual(entry, entryBytes);
    const stateBytes = await bytesAt(await regularFile(target, '.tool-supply-state.json'));
    const state = JSON.parse(stateBytes.toString('utf8'));
    assert.equal(state.module_id, moduleId);
    assert.equal(state.version, '1.0.0');
    assert.equal(state.manifest_version, 'fixture-1.0.0');
    assert.equal(state.sha256, checksum);
    assert.equal(state.kind, 'runtime');
    assert.equal(state.feature_key, runtimeFeatureKey);
    assert.equal(state.entry_file, 'entry.txt');
    assert.equal(state.archive_root, 'bundle');
    assert.equal(await absent(join(installRoot, '.transactions', moduleId)), true);
    installed.push({ module_id: moduleId, entry: identity(entry), state: identity(stateBytes) });
  }
  const callsBeforeReady = sourceCalls.length;
  const ready = await client.run(prefix + 'status', input, 'mcp');
  assert.equal(
    sourceCalls.slice(callsBeforeReady).filter((call) => call.kind === 'catalog').length,
    1,
  );
  assert.equal(ready.feature_key, runtimeFeatureKey);
  assert.equal(ready.manifest_version, 'fixture-1.0.0');
  assert.equal(ready.ready, true);
  assert.equal(ready.found, true);
  assert.equal(ready.source_error, null);
  assert.deepEqual(liveSource(ready), liveSource(unknown));
  assert.deepEqual(
    ready.modules.map((module) => module.module_id),
    runtimeModuleIds,
  );
  for (const module of ready.modules) {
    assert.equal(module.kind, 'runtime');
    assert.equal(module.feature_key, runtimeFeatureKey);
    assert.equal(module.available_version, '1.0.0');
    assert.equal(module.required, false);
    assert.equal(module.size, bytes);
    assert.equal(module.action, 'current');
    assert.equal(module.entry_present, true);
    assert.equal(module.installed_version, '1.0.0');
  }
  const callsBeforeRepeat = sourceCalls.length;
  const repeat = await client.run(prefix + 'prepare', input);
  const repeatCalls = sourceCalls.slice(callsBeforeRepeat);
  assert.equal(repeatCalls.filter((call) => call.kind === 'catalog').length, 1);
  assert.equal(repeatCalls.filter((call) => call.kind === 'archive').length, 0);
  assert.deepEqual(repeat, {
    ...prepared,
    modules: prepared.modules.map((module) => ({ ...module, changed: false })),
  });
  const calls = sourceCalls.slice(sourceStart);
  const downloads = calls.filter((call) => call.kind === 'archive');
  assert.equal(downloads.length, runtimeModuleIds.length);
  assert.equal(calls.filter((call) => call.kind === 'catalog').length, 5);
  for (const call of downloads) {
    assert.equal(call.completed, true);
    assert.equal(call.status, 200);
    assert.equal(call.output.sha256, checksum);
    assert.equal(call.output.bytes, bytes);
  }
  for (const moduleId of runtimeModuleIds) {
    const removed = await client.run('plugin.tool-supply.remove', { module_id: moduleId }, 'mcp');
    assert.equal(removed.removed, true);
    assert.equal(removed.module_id, moduleId);
    assert.equal(await absent(join(installRoot, moduleId)), true);
    assert.equal(await absent(join(installRoot, '.transactions', moduleId)), true);
  }
  return {
    feature_key: runtimeFeatureKey,
    installed,
    single_snapshot: true,
    repeat_without_download: true,
    matching_runtime_only: true,
    downloads: downloads.length,
  };
}
