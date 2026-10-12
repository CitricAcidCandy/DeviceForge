import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, object, value, type Host, type JsonObject } from './six-business-support.ts';
import { identities, type Reporter } from './ordinary-business-report.ts';
import { absent, cacheMeta, cacheSnapshot, cacheTerminal, installed, originalBudgetTerminal, ownedPath, type CacheTerminal } from './ordinary-tool-cache-evidence.ts';
import { cachePackage, type CachePackage, type ToolCacheSource } from './ordinary-tool-cache-source.ts';

export type CacheLedger = { jobs: CacheTerminal[]; submissions: string[]; links: JsonObject[]; cases: JsonObject[] };
export type CacheSeed = {
  key: string; version: string; modulesA: CachePackage[]; modulesB: CachePackage[];
  selectedA: CachePackage[]; selectedB: CachePackage[]; spare: CachePackage;
  digestA: string; snapshotA: Awaited<ReturnType<typeof cacheSnapshot>>;
  installedA: JsonObject[]; viaMcp: boolean;
};

export async function cacheLoaded(host: Host) {
  const response = await host.request('/api/v2/plugins'); assert.equal(response.response.status, 200);
  assert.ok(Array.isArray(response.json)); assert.equal(response.json.length, 1);
  const plugin = object(response.json[0]); assert.equal(plugin.id, 'tool-supply');
  assert.equal(plugin.state, 'loaded'); assert.equal(plugin.cleanup_failed, false);
  assert.deepEqual(await host.mcp('deviceforge.list_plugins', {}), response.json);
  return { id: plugin.id, state: plugin.state, cleanup_failed: plugin.cleanup_failed };
}

function helpers(host: Host, source: ToolCacheSource, audit: Reporter, ledger: CacheLedger, viaMcp: boolean, installRoot: string) {
  const transport = viaMcp ? 'mcp' : 'http';
  const record = async (job: JsonObject, expected: string, operation: string, requestStart: number) => {
    const terminal = cacheTerminal(job); ledger.jobs.push(terminal);
    ledger.links.push({ transport, ...terminal, requests: host.requests.slice(requestStart) });
    await audit.recordJob(host, job, expected, operation); await audit.flush();
    assert.equal(job.status, expected); assert.deepEqual(cacheTerminal(await host.shared(String(job.id))), terminal);
    return job;
  };
  const submit = async (name: string, input: JsonObject, selectedTransport = viaMcp) => {
    const operation = `plugin.tool-supply.${name}`; const requestStart = host.requests.length;
    const pending = object(await host.submit(operation, input, selectedTransport));
    const submission = host.requests[requestStart]; assert.ok(submission);
    ledger.submissions.push(submission.log_id);
    ledger.links.push({ transport: selectedTransport ? 'mcp' : 'http', phase: 'submitted', id: pending.id, operation, submit_log_id: submission.log_id });
    await audit.flush(); return { pending, operation, requestStart };
  };
  const run = async (name: string, input: JsonObject, expected = 'succeeded', selectedTransport = viaMcp) => {
    const submission = await submit(name, input, selectedTransport);
    return record(await host.finished(String(submission.pending.id)), expected, submission.operation, submission.requestStart);
  };
  const meta = (result: JsonObject, origin: 'live' | 'cache' | null, version: string | null, expectedSha?: string) => {
    const metadata = cacheMeta(result, origin, version, source.base, installRoot);
    if (expectedSha !== undefined) assert.equal(result.manifest_sha256, expectedSha);
    return metadata;
  };
  const traffic = async (start: number, downloads: CachePackage[], catalogMode: string, archiveStatus = 200) => {
    await source.settled(start); const calls = source.calls.slice(start);
    const evidence = { transport, source_sequences: calls.map((call) => call.sequence), catalog_mode: catalogMode,
      catalog_requests: calls.filter((call) => call.kind === 'catalog').length,
      archive_modules: calls.filter((call) => call.kind === 'archive').map((call) => call.module_id) };
    ledger.cases.push({ case: 'source_traffic', ...evidence }); await audit.flush();
    assert.deepEqual(calls.map((call) => [call.kind, call.module_id]), [['catalog', null], ...downloads.map((item) => ['archive', item.module_id])]);
    const catalog = calls[0]; assert.ok(catalog); assert.equal(catalog.mode, catalogMode);
    assert.equal(catalog.status, catalogMode === 'http' ? 503 : 200);
    for (const call of calls) { assert.equal(call.method, 'GET'); assert.equal(call.input_bytes, 0); assert.equal(call.closed, true); }
    for (const [index, item] of downloads.entries()) {
      const call = calls[index + 1]; assert.ok(call); assert.equal(call.status, archiveStatus);
      if (archiveStatus === 200) assert.equal(call.response_sha256, hash(item.archive));
    }
    return evidence;
  };
  const rows = (result: JsonObject) => { assert.ok(Array.isArray(result.modules)); return result.modules.map(object); };
  const status = (result: JsonObject, key: string, modules: CachePackage[], actions: string[]) => {
    assert.equal(result.feature_key, key); assert.equal(result.found, modules.length > 0);
    assert.equal(result.ready, modules.length > 0 && actions.every((action) => action === 'current'));
    const actual = rows(result); assert.deepEqual(actual.map((row) => row.module_id), modules.map((item) => item.module_id));
    assert.deepEqual(actual.map((row) => row.action), actions);
    for (const [index, item] of modules.entries()) {
      const row = actual[index]; assert.ok(row); assert.equal(row.kind, 'runtime');
      assert.equal(row.feature_key, key); assert.equal(row.available_version, item.version);
      if (actions[index] === 'current') assert.equal(row.entry_present, true);
    }
  };
  const prepared = (result: JsonObject, key: string, modules: CachePackage[], changed: boolean[]) => {
    assert.equal(result.feature_key, key); assert.equal(result.ready, true);
    assert.deepEqual(rows(result), modules.map((item, index) => ({ module_id: item.module_id, version: item.version, sha256: item.checksum, changed: changed[index] })));
    assert.deepEqual(Object.keys(result).sort(), ['feature_key', 'manifest_version', 'manifest_source', 'manifest_sha256', 'source_error', 'ready', 'modules'].sort());
  };
  const evidence = async (name: string, job: JsonObject, metadata?: JsonObject) => {
    ledger.cases.push({ case: name, transport, ...cacheTerminal(job), ...(metadata ?? {}) }); await audit.flush();
  };
  return { transport, record, submit, run, meta, traffic, rows, status, prepared, evidence };
}

export async function toolCacheSeed(host: Host, source: ToolCacheSource, audit: Reporter, ledger: CacheLedger, root: string, installRoot: string, viaMcp: boolean): Promise<CacheSeed> {
  const check = helpers(host, source, audit, ledger, viaMcp, installRoot); const transport = check.transport;
  const key = `合成缓存功能/${transport}`; const version = '1.0.0';
  const firstA = cachePackage(`cache-${transport}-first`, key, '内容A');
  const secondA = cachePackage(`cache-${transport}-second`, key, '内容A');
  const firstB = cachePackage(firstA.module_id, key, '内容B，同版本');
  const secondB = cachePackage(secondA.module_id, key, '内容B，同版本');
  const ignored = cachePackage(`cache-${transport}-ignored`, key, '不匹配tool', 'tool');
  const spare = cachePackage(`cache-${transport}-spare`, `合成缓存新安装/${transport}`, '未安装备用模块');
  const selectedA = [firstA, secondA]; const selectedB = [firstB, secondB];
  const modulesA = [ignored, firstA, spare, secondA]; const modulesB = [ignored, firstB, spare, secondB];
  let digestA = ''; const snapshots: { initial?: Awaited<ReturnType<typeof cacheSnapshot>> } = {};
  const installedA: JsonObject[] = [];
  await audit.check(`缓存 ${transport}：live A 五操作元数据与仅runtime安装`, async () => {
    await source.catalog(version, modulesA);
    for (const [name, input] of [['catalog', {}], ['plan', { module_ids: selectedA.map((item) => item.module_id) }]] as const) {
      const start = source.calls.length; const job = await check.run(name, input); const result = value(job);
      const metadata = check.meta(result, 'live', version, digestA || undefined);
      const digest = result.manifest_sha256; assert.ok(typeof digest === 'string'); digestA = digest;
      await check.evidence(`live_A_${name}`, job, metadata); await check.traffic(start, [], 'live');
      assert.deepEqual(check.rows(result).map((row) => row.module_id), (name === 'catalog' ? modulesA : selectedA).map((item) => item.module_id));
    }
    const installStart = source.calls.length; const installation = await check.run('install', { module_id: firstA.module_id });
    const installResult = value(installation); await check.evidence('live_A_install', installation, check.meta(installResult, 'live', version, digestA));
    assert.equal(installResult.changed, true); assert.equal(installResult.sha256, firstA.checksum); await check.traffic(installStart, [firstA], 'live');
    const statusStart = source.calls.length; const statusJob = await check.run('runtime_feature.status', { feature_key: key });
    const statusResult = value(statusJob); await check.evidence('live_A_status', statusJob, check.meta(statusResult, 'live', version, digestA));
    check.status(statusResult, key, selectedA, ['current', 'install']); await check.traffic(statusStart, [], 'live');
    const prepareStart = source.calls.length; const preparation = await check.run('runtime_feature.prepare', { feature_key: key });
    const result = value(preparation); await check.evidence('live_A_prepare', preparation, check.meta(result, 'live', version, digestA));
    check.prepared(result, key, selectedA, [false, true]); await check.traffic(prepareStart, [secondA], 'live');
    for (const item of selectedA) installedA.push({ module_id: item.module_id, ...await installed(installRoot, item, version) });
    await absent(join(installRoot, ignored.module_id)); await absent(join(installRoot, spare.module_id));
    snapshots.initial = await cacheSnapshot(root, installRoot, `${transport}-live-A`, modulesA, digestA, source.base + '/catalog');
    ledger.cases.push({ case: 'live_A_snapshot', transport, ...snapshots.initial.evidence, installed: installedA });
    await cacheLoaded(host);
  });
  assert.ok(snapshots.initial);
  return { key, version, modulesA, modulesB, selectedA, selectedB, spare, digestA, snapshotA: snapshots.initial, installedA, viaMcp };
}

export async function toolCacheARecovery(host: Host, source: ToolCacheSource, audit: Reporter, ledger: CacheLedger, installRoot: string, seed: CacheSeed) {
  const check = helpers(host, source, audit, ledger, seed.viaMcp, installRoot);
  await audit.check(`缓存 ${check.transport}：新进程 cache A 只读恢复`, async () => {
    source.mode('http'); const start = source.calls.length;
    const statusJob = await check.run('runtime_feature.status', { feature_key: seed.key }); const statusResult = value(statusJob);
    check.meta(statusResult, 'cache', seed.version, seed.digestA); check.status(statusResult, seed.key, seed.selectedA, ['current', 'current']);
    await check.evidence('cache_A_new_process_status', statusJob); await check.traffic(start, [], 'http');
    const prepareStart = source.calls.length; const prepareJob = await check.run('runtime_feature.prepare', { feature_key: seed.key });
    const prepareResult = value(prepareJob); check.meta(prepareResult, 'cache', seed.version, seed.digestA);
    check.prepared(prepareResult, seed.key, seed.selectedA, [false, false]);
    await check.evidence('cache_A_new_process_prepare', prepareJob); await check.traffic(prepareStart, [], 'http');
    assert.deepEqual(await readFile(seed.snapshotA.path), seed.snapshotA.bytes);
    const actual: JsonObject[] = [];
    for (const item of seed.selectedA) actual.push({ module_id: item.module_id, ...await installed(installRoot, item, seed.version) });
    assert.deepEqual(actual, seed.installedA); await cacheLoaded(host);
  });
}

export async function toolCacheCases(host: Host, source: ToolCacheSource, audit: Reporter, ledger: CacheLedger, root: string, installRoot: string, seed: CacheSeed) {
  const check = helpers(host, source, audit, ledger, seed.viaMcp, installRoot); const transport = check.transport;
  let digestB = ''; const snapshots: { updated?: Awaited<ReturnType<typeof cacheSnapshot>> } = {};
  const modulesB = seed.modulesB; const selectedB = seed.selectedB;
  await audit.check(`缓存 ${transport}：同版本新内容 live B 更新摘要与归档`, async () => {
    await source.catalog(seed.version, modulesB); const statusStart = source.calls.length;
    const statusJob = await check.run('runtime_feature.status', { feature_key: seed.key }); const statusResult = value(statusJob);
    const metadata = check.meta(statusResult, 'live', seed.version); const manifestSha = statusResult.manifest_sha256;
    assert.ok(typeof manifestSha === 'string'); digestB = manifestSha; assert.notEqual(digestB, seed.digestA);
    check.status(statusResult, seed.key, selectedB, ['repair', 'repair']);
    await check.evidence('live_B_same_version', statusJob, metadata); await check.traffic(statusStart, [], 'live');
    const prepareStart = source.calls.length; const prepareJob = await check.run('runtime_feature.prepare', { feature_key: seed.key });
    const prepareResult = value(prepareJob); check.meta(prepareResult, 'live', seed.version, digestB);
    check.prepared(prepareResult, seed.key, selectedB, [true, true]);
    await check.evidence('live_B_prepare', prepareJob, { manifest_sha256: digestB }); await check.traffic(prepareStart, selectedB, 'live');
    for (const item of selectedB) {
      const installedBytes = await installed(installRoot, item, seed.version);
      ledger.cases.push({ case: 'live_B_installed', transport, module_id: item.module_id, ...installedBytes });
    }
    snapshots.updated = await cacheSnapshot(root, installRoot, `${transport}-live-B`, modulesB, digestB, source.base + '/catalog');
    ledger.cases.push({ case: 'live_B_snapshot', transport, ...snapshots.updated.evidence,
      previous_manifest_sha256: seed.digestA, same_version_content_changed: true }); await audit.flush();
  });
  assert.ok(snapshots.updated);
  const frozenB = snapshots.updated;
  const committedB: JsonObject[] = [];
  for (const item of selectedB) committedB.push({ module_id: item.module_id, ...await installed(installRoot, item, seed.version) });
  await audit.check(`缓存 ${transport}：新进程来源失败回退 B、未知功能与重复准备零下载`, async () => {
    const first = selectedB[0]; assert.ok(first);
    for (const [name, input] of [['catalog', {}], ['plan', { module_ids: selectedB.map((item) => item.module_id) }],
      ['install', { module_id: first.module_id }]] as const) {
      source.mode('http'); const start = source.calls.length;
      const job = await check.run(name, input);
      const result = value(job); await check.evidence(`cache_B_${name}`, job, check.meta(result, 'cache', seed.version, digestB));
      if (name === 'install') { assert.equal(result.changed, false); assert.equal(result.sha256, first.checksum); }
      else assert.deepEqual(check.rows(result).map((row) => row.module_id), (name === 'catalog' ? modulesB : selectedB).map((item) => item.module_id));
      await check.traffic(start, [], 'http');
    }
    source.mode('http'); const statusStart = source.calls.length;
    const statusJob = await check.run('runtime_feature.status', { feature_key: seed.key }); const statusResult = value(statusJob);
    check.meta(statusResult, 'cache', seed.version, digestB); check.status(statusResult, seed.key, selectedB, ['current', 'current']);
    await check.evidence('cache_B_status', statusJob, { source_error_sha256: hash(String(statusResult.source_error)) }); await check.traffic(statusStart, [], 'http');
    const prepareStart = source.calls.length; const prepareJob = await check.run('runtime_feature.prepare', { feature_key: seed.key });
    const prepareResult = value(prepareJob); check.meta(prepareResult, 'cache', seed.version, digestB); check.prepared(prepareResult, seed.key, selectedB, [false, false]);
    await check.evidence('cache_B_repeat_prepare', prepareJob); await check.traffic(prepareStart, [], 'http');
    const unknownKey = `缓存未知/${transport}`; const unknownStatusStart = source.calls.length;
    const unknownStatus = await check.run('runtime_feature.status', { feature_key: unknownKey }); const unknownResult = value(unknownStatus);
    check.meta(unknownResult, 'cache', seed.version, digestB); check.status(unknownResult, unknownKey, [], []);
    await check.evidence('cache_unknown_status', unknownStatus); await check.traffic(unknownStatusStart, [], 'http');
    const unknownPrepareStart = source.calls.length; const unknownPrepare = await check.run('runtime_feature.prepare', { feature_key: unknownKey }, 'failed');
    assert.equal(unknownPrepare.error, '依赖执行失败：输入或清单无效：清单不存在指定运行时功能');
    await check.evidence('cache_unknown_prepare', unknownPrepare); await check.traffic(unknownPrepareStart, [], 'http');
    for (const mode of ['disconnect', 'json', 'schema'] as const) {
      source.mode(mode); const start = source.calls.length; const job = await check.run('runtime_feature.status', { feature_key: seed.key });
      const result = value(job); await check.evidence(`cache_B_${mode}`, job, check.meta(result, 'cache', seed.version, digestB));
      check.status(result, seed.key, selectedB, ['current', 'current']); await check.traffic(start, [], mode);
    }
    source.mode('http'); assert.deepEqual(await readFile(frozenB.path), frozenB.bytes);
  });
  await audit.check(`缓存 ${transport}：新模块只能继续归档下载，清单缓存不提供离线安装`, async () => {
    source.archivesAvailable(false);
    const start = source.calls.length; const failed = await check.run('install', { module_id: seed.spare.module_id }, 'failed');
    assert.ok(typeof failed.error === 'string'); assert.ok(!String(failed.error).includes('synthetic-cache-marker'));
    await check.evidence('cache_no_offline_install', failed, { module_id: seed.spare.module_id }); await check.traffic(start, [seed.spare], 'http', 503);
    await absent(join(installRoot, seed.spare.module_id)); await absent(join(installRoot, '.transactions', seed.spare.module_id));
  });
  const snapshotPath = frozenB.path; const originalSnapshot = frozenB.bytes;
  await audit.check(`缓存 ${transport}：缺失仅查询降级、准备失败且不改安装`, async () => {
    const missing = ownedPath(root, join(root, 'cache-originals', `${transport}-missing.bin`)); await rename(snapshotPath, missing);
    try {
      const start = source.calls.length; const statusJob = await check.run('runtime_feature.status', { feature_key: seed.key }); const statusResult = value(statusJob);
      check.meta(statusResult, null, null); check.status(statusResult, seed.key, [], []); await check.evidence('cache_missing_status', statusJob);
      await check.traffic(start, [], 'http');
      const catalogStart = source.calls.length; const catalogJob = await check.run('catalog', {}); const catalogResult = value(catalogJob);
      check.meta(catalogResult, null, null); assert.deepEqual(check.rows(catalogResult).map((row) => [row.module_id, row.action]).sort(),
        selectedB.map((item) => [item.module_id, 'local_only']).sort());
      await check.evidence('cache_missing_catalog', catalogJob); await check.traffic(catalogStart, [], 'http');
      for (const [name, input] of [['plan', { module_ids: selectedB.map((item) => item.module_id) }],
        ['install', { module_id: seed.spare.module_id }], ['runtime_feature.prepare', { feature_key: seed.key }]] as const) {
        const failedStart = source.calls.length; const failed = await check.run(name, input, 'failed');
        assert.ok(typeof failed.error === 'string'); await check.evidence(`cache_missing_${name}`, failed); await check.traffic(failedStart, [], 'http');
      }
      const state = await Promise.all(seed.selectedB.map((item) => installed(installRoot, item, seed.version))); assert.equal(state.length, 2);
    } finally { await rename(missing, snapshotPath); }
  });
  await audit.check(`缓存 ${transport}：损坏快照硬失败且不查询降级`, async () => {
    const corrupt = Buffer.from('{"schema_version":1,"synthetic_cache_corrupt":true}');
    ledger.cases.push({ case: 'corrupt_injection', transport, original_sha256: hash(originalSnapshot), corrupt_sha256: hash(corrupt) });
    await audit.flush(); await writeFile(snapshotPath, corrupt);
    try {
      for (const [name, input] of [['runtime_feature.status', { feature_key: seed.key }], ['catalog', {}],
        ['runtime_feature.prepare', { feature_key: seed.key }]] as const) {
        const start = source.calls.length; const failed = await check.run(name, input, 'failed');
        assert.ok(typeof failed.error === 'string'); assert.ok(!String(failed.error).includes('synthetic-cache-marker'));
        await check.evidence(`cache_corrupt_${name}`, failed); await check.traffic(start, [], 'http');
      }
    } finally { await writeFile(snapshotPath, originalSnapshot); }
  });
  const unchanged = async () => {
    assert.deepEqual(await readFile(snapshotPath), originalSnapshot);
    const actual: JsonObject[] = [];
    for (const item of selectedB) actual.push({ module_id: item.module_id, ...await installed(installRoot, item, seed.version) });
    assert.deepEqual(actual, committedB); await absent(join(installRoot, seed.spare.module_id));
  };
  await audit.check(`缓存 ${transport}：来源在途取消不回退且连接关闭`, async () => {
    const owner = await cacheLoaded(host); source.mode('hold'); const start = source.calls.length;
    const submission = await check.submit('runtime_feature.status', { feature_key: seed.key });
    const gate = await source.gate(start); assert.equal(gate.finished, false); assert.equal(gate.closed, false);
    assert.equal((await host.shared(String(submission.pending.id))).status, 'running'); await unchanged();
    ledger.cases.push({ case: 'cancel_gate', transport, job_id: submission.pending.id, source_sequence: gate.sequence,
      first_block_bytes: gate.sent_bytes, source_finished: gate.finished, owner }); await audit.flush();
    const beforeCancel = source.calls.length;
    await host.cancel(String(submission.pending.id), !seed.viaMcp);
    const cancelled = await check.record(await host.finished(String(submission.pending.id)), 'cancelled', submission.operation, submission.requestStart);
    await source.connectionClosed(gate.sequence); assert.equal(source.calls.length, beforeCancel); assert.equal(gate.finished, false);
    await check.traffic(start, [], 'hold'); await unchanged(); assert.deepEqual(await cacheLoaded(host), owner);
    await check.evidence('cache_cancelled', cancelled, { source_sequence: gate.sequence, connection_closed: true, cache_and_installed_bytes_unchanged: true });
    source.mode('http'); const callableStart = source.calls.length;
    const callable = await check.run('runtime_feature.status', { feature_key: seed.key }); const result = value(callable);
    check.meta(result, 'cache', seed.version, digestB); check.status(result, seed.key, selectedB, ['current', 'current']);
    await check.traffic(callableStart, [], 'http'); await check.evidence('post_cancel_callable', callable);
  });
  await audit.check(`缓存 ${transport}：自然到期不回退`, async () => {
    const owner = await cacheLoaded(host); source.mode('hold'); const start = source.calls.length; const started = Date.now();
    const submission = await check.submit('runtime_feature.status', { feature_key: seed.key });
    const gate = await source.gate(start); assert.equal((await host.shared(String(submission.pending.id))).status, 'running');
    ledger.cases.push({ case: 'expiry_gate', transport, job_id: submission.pending.id, source_sequence: gate.sequence,
      original_budget_ms: 120000, first_block_bytes: gate.sent_bytes, started_at: new Date(started).toISOString() }); await audit.flush();
    const terminal = await check.record(await originalBudgetTerminal(host, String(submission.pending.id), started, 120000), 'failed', submission.operation, submission.requestStart);
    const elapsed = Date.now() - started;
    await check.evidence('cache_natural_expiry', terminal, { original_budget_ms: 120000, elapsed_ms: elapsed,
      source_sequence: gate.sequence, cancel_request_sent: false });
    assert.ok(elapsed >= 119000, '不得把提前来源失败当自然到期');
    assert.ok(typeof terminal.error === 'string' && /超时|期限已到期/.test(terminal.error));
    assert.equal(gate.finished, false); await source.connectionClosed(gate.sequence); await check.traffic(start, [], 'hold');
    await unchanged(); assert.deepEqual(await cacheLoaded(host), owner); source.mode('http');
    const callableStart = source.calls.length; const callable = await check.run('runtime_feature.status', { feature_key: seed.key });
    const result = value(callable); check.meta(result, 'cache', seed.version, digestB); check.status(result, seed.key, selectedB, ['current', 'current']);
    await check.traffic(callableStart, [], 'http'); await check.evidence('post_expiry_callable', callable);
  });
  return { digestB, snapshotB: frozenB, jobs: ledger.jobs, inputs: await identities(root, [installRoot], []) };
}
