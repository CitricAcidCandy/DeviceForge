import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inside } from '../../cli/src/paths.mjs';
import { runtimeFeatureKey, runtimeModuleIds, verifyRuntimeFeatureNpx } from '../cli-smoke-ordinary-feature.mjs';

const identity = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

async function fixture(run, extraSnapshot = false, invalidMetadata = false) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'deviceforge-feature-npx-test-'));
  try {
    const entryBytes = Buffer.from('合成运行时文本');
    const archive = Buffer.from('仅用于验收辅助单元测试的归档身份');
    const checksum = identity(archive).sha256;
    const sourceCalls = [];
    const invocations = [];
    let prepared = false;
    const client = { async run(operation, input, transport) {
      invocations.push({ operation, input, transport });
      if (operation.endsWith('.remove')) {
        const target = resolve(root, input.module_id);
        assert.ok(target !== root && inside(root, target));
        await rm(target, { recursive: true });
        return { module_id: input.module_id, removed: true };
      }
      sourceCalls.push({ kind: 'catalog' });
      if (operation.endsWith('.status')) {
        const known = input.feature_key === runtimeFeatureKey;
        return { feature_key: input.feature_key, manifest_version: 'fixture-1.0.0', source_error: null,
          manifest_source: invalidMetadata ? 'cache' : 'live', manifest_sha256: 'c'.repeat(64),
          found: known, ready: known && prepared, modules: known ? runtimeModuleIds.map((moduleId) => ({
            module_id: moduleId, kind: 'runtime', feature_key: runtimeFeatureKey, action: prepared ? 'current' : 'install',
            installed_version: prepared ? '1.0.0' : null, entry_present: prepared,
            available_version: '1.0.0', required: false, size: archive.length,
          })) : [] };
      }
      assert.equal(operation, 'plugin.tool-supply.runtime_feature.prepare');
      const changed = !prepared;
      if (changed) {
        for (const moduleId of runtimeModuleIds) {
          const target = join(root, moduleId);
          await mkdir(target);
          await writeFile(join(target, 'entry.txt'), entryBytes);
          await writeFile(join(target, '.tool-supply-state.json'), JSON.stringify({
            module_id: moduleId, version: '1.0.0', sha256: checksum, kind: 'runtime', manifest_version: 'fixture-1.0.0',
            feature_key: runtimeFeatureKey, entry_file: 'entry.txt', archive_root: 'bundle',
          }));
          sourceCalls.push({ kind: 'archive', completed: true, status: 200, output: identity(archive) });
        }
        if (extraSnapshot) sourceCalls.push({ kind: 'catalog' });
        prepared = true;
      }
      return { feature_key: runtimeFeatureKey, manifest_version: 'fixture-1.0.0', ready: true,
        source_error: null, manifest_source: 'live', manifest_sha256: 'c'.repeat(64),
        modules: runtimeModuleIds.map((moduleId) => ({ module_id: moduleId, version: '1.0.0', sha256: checksum, changed })) };
    } };
    const absent = async (path) => {
      try { await lstat(path); return false; }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    };
    await run(() => verifyRuntimeFeatureNpx({ client, installRoot: root, checksum, bytes: archive.length,
      entryBytes, sourceCalls, bytesAt: readFile, absent, identity }), invocations);
  } finally {
    const target = resolve(root);
    assert.ok(target !== parent && inside(parent, target));
    await rm(target, { recursive: true, force: true });
  }
}

test('npx运行时辅助沿公开任务顺序核对双模块、原字节及重复准备无下载', async () => {
  await fixture(async (verify, invocations) => {
    const evidence = await verify();
    assert.equal(evidence.downloads, 2);
    assert.equal(evidence.repeat_without_download, true);
    assert.deepEqual(evidence.installed.map((module) => module.module_id), runtimeModuleIds);
    assert.equal(invocations.length, 7);
    assert.equal(invocations.filter((call) => call.operation.endsWith('.prepare')).length, 2);
  });
});

test('npx运行时辅助拒绝准备中重复读取清单，不把单元夹具当真实包证据', async () => {
  await fixture(async (verify) => { await assert.rejects(verify(), { code: 'ERR_ASSERTION' }); }, true);
});

test('npx运行时辅助拒绝错误来源元数据，不把回退来源借记当前来源成功', async () => {
  await fixture(async (verify) => { await assert.rejects(verify(), { code: 'ERR_ASSERTION' }); }, false, true);
});
