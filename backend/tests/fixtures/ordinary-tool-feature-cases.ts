import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { hash, object, poll, portReleased, value, type Host, type JsonObject } from './six-business-support.ts';
import { zip } from './ordinary-business-source.ts';
import type { Reporter } from './ordinary-business-report.ts';

type FeaturePackage = {
  module_id: string; kind: 'runtime' | 'tool'; feature_key: string; version: string;
  entry: Buffer; archive: Buffer; checksum: string;
};
type SourceCall = {
  sequence: number; kind: string; module_id: string | null; manifest_version: string | null;
  method: string; status: number; input_bytes: number; input_sha256: string;
  response_bytes: number; response_sha256: string | null; finished: boolean; closed: boolean;
};
type Catalog = { bytes: Buffer; status: number; version: string | null };

function fixture(moduleId: string, featureKey: string, version = '1.0.0', kind: 'runtime' | 'tool' = 'runtime'): FeaturePackage {
  const entry = Buffer.from(`合成运行时文本：${moduleId}，版本${version}\n`, 'utf8');
  const archive = zip([{ name: 'bundle/entry.txt', bytes: entry }]);
  return { module_id: moduleId, kind, feature_key: featureKey, version, entry, archive, checksum: hash(archive) };
}

export async function toolFeatureSource() {
  const calls: SourceCall[] = [];
  const faults: JsonObject[] = [];
  const inputs: JsonObject[] = [];
  const transitions: JsonObject[] = [];
  const archives = new Map<string, FeaturePackage>();
  let catalog: Catalog = { bytes: Buffer.from('{}'), status: 200, version: null };
  let nextCatalog: { module_id: string; catalog: Catalog } | undefined;
  let holdId: string | undefined;
  let held: { call: SourceCall; response: ServerResponse } | undefined;
  let closed = false;
  let base = '';
  const fault = (error: unknown) => {
    const record = error instanceof Error ? error : new Error('合成源非标准异常');
    faults.push({ type: record.name, message_sha256: hash(record.message) });
  };
  const pathFor = (item: FeaturePackage) => `/archives/${item.module_id}-${item.version}.zip`;
  const makeCatalog = (version: string, modules: FeaturePackage[]): Catalog => {
    for (const item of modules) {
      archives.set(pathFor(item), item);
      inputs.push({ kind: 'archive', module_id: item.module_id, version: item.version,
        bytes: item.archive.length, sha256: hash(item.archive), declared_sha256: item.checksum });
    }
    const manifest = { manifestVersion: version, generatedAt: '2026-10-12', modules: modules.map((item) => ({
      name: item.module_id, type: item.kind, featureKey: item.feature_key, version: item.version,
      url: base + pathFor(item), sha256: item.checksum, size: item.archive.length,
      required: false, archiveRoot: 'bundle', entryFile: 'entry.txt',
    })) };
    const bytes = Buffer.from(JSON.stringify(manifest));
    inputs.push({ kind: 'catalog', manifest_version: version, bytes: bytes.length, sha256: hash(bytes) });
    return { bytes, status: 200, version };
  };
  const respond = (response: ServerResponse, call: SourceCall, bytes: Buffer, status: number, contentType: string, hold = false) => {
    call.status = status; call.response_bytes = bytes.length; call.response_sha256 = hash(bytes);
    response.writeHead(status, { 'content-type': contentType, 'content-length': bytes.length });
    if (hold) {
      held = { call, response }; response.write(bytes.subarray(0, Math.min(32, bytes.length))); return;
    }
    response.end(bytes);
  };
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const item = archives.get(path);
    const call: SourceCall = { sequence: calls.length + 1, kind: path === '/catalog' ? 'catalog' : item ? 'archive' : 'unknown',
      module_id: item?.module_id ?? null, manifest_version: path === '/catalog' ? catalog.version : null,
      method: request.method ?? '', status: 0, input_bytes: 0, input_sha256: hash(Buffer.alloc(0)),
      response_bytes: 0, response_sha256: null, finished: false, closed: false };
    const selectedCatalog = catalog;
    calls.push(call);
    response.once('finish', () => { call.finished = true; });
    response.once('close', () => { call.closed = true; });
    response.once('error', fault);
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of request) {
        const bytes = Buffer.from(part); call.input_bytes += bytes.length;
        assert.ok(call.input_bytes <= 1024, '合成源输入超过限制'); parts.push(bytes);
      }
      call.input_sha256 = hash(Buffer.concat(parts));
      assert.equal(request.method, 'GET', '合成源仅接受只读请求');
      if (path === '/catalog') {
        respond(response, call, selectedCatalog.bytes, selectedCatalog.status, 'application/json'); return;
      }
      if (item) {
        if (nextCatalog?.module_id === item.module_id) {
          transitions.push({ sequence: call.sequence, module_id: item.module_id,
            previous_version: catalog.version, next_version: nextCatalog.catalog.version,
            previous_sha256: hash(catalog.bytes), next_sha256: hash(nextCatalog.catalog.bytes) });
          catalog = nextCatalog.catalog; nextCatalog = undefined;
        }
        respond(response, call, item.archive, 200, 'application/zip', holdId === item.module_id); return;
      }
      throw new Error('合成源收到未知路由');
    })().catch((error) => { fault(error); response.destroy(); });
  });
  server.on('error', fault);
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  return {
    base, calls, faults, inputs, transitions,
    catalog(version: string, modules: FeaturePackage[]) {
      assert.equal(closed, false); catalog = makeCatalog(version, modules); nextCatalog = undefined; holdId = undefined; held = undefined;
    },
    afterDownload(moduleId: string, version: string, modules: FeaturePackage[]) {
      assert.equal(closed, false); nextCatalog = { module_id: moduleId, catalog: makeCatalog(version, modules) };
    },
    badCatalog(mode: 'http' | 'json' | 'schema') {
      assert.equal(closed, false); nextCatalog = undefined; holdId = undefined; held = undefined;
      const bytes = mode === 'json' ? Buffer.from('synthetic-source-marker:不是JSON')
        : Buffer.from(JSON.stringify(mode === 'schema' ? { manifestVersion: '', generatedAt: 'synthetic-source-marker', modules: [] }
          : { error: 'synthetic-source-marker' }));
      catalog = { bytes, status: mode === 'http' ? 503 : 200, version: null };
      inputs.push({ kind: 'catalog_fault', mode, bytes: bytes.length, sha256: hash(bytes) });
    },
    holdDownload(moduleId: string) { assert.equal(closed, false); holdId = moduleId; held = undefined; },
    async waitDownload(moduleId: string) {
      return poll(async () => held?.call, (call) => call?.module_id === moduleId, '运行时模块下载首块门闩');
    },
    async downloadClosed(moduleId: string) {
      return poll(async () => held?.call, (call) => call?.module_id === moduleId && call.closed, '运行时取消后连接释放');
    },
    async close() {
      if (!closed) {
        closed = true;
        await new Promise<void>((done, reject) => {
          server.close((error) => error ? reject(error) : done()); server.closeAllConnections();
        });
      }
      return { port: address.port, port_released: await portReleased(address.port),
        fault_count: faults.length, open_responses: calls.filter((call) => !call.closed).length };
    },
  };
}

export type ToolFeatureSource = Awaited<ReturnType<typeof toolFeatureSource>>;

export type ToolFeatureJobEvidence = {
  id: string; operation: string; status: string; input_sha256: string; result_sha256: string; error_sha256: string | null;
};

function terminal(job: JsonObject): ToolFeatureJobEvidence {
  return { id: String(job.id), operation: String(job.operation), status: String(job.status),
    input_sha256: hash(JSON.stringify(job.input ?? null)), result_sha256: hash(JSON.stringify(job.result ?? null)),
    error_sha256: typeof job.error === 'string' ? hash(job.error) : null };
}

export async function toolFeatureCases(host: Host, remote: ToolFeatureSource, audit: Reporter, installRoot: string) {
  const evidence: JsonObject[] = [];
  const jobs: ToolFeatureJobEvidence[] = [];
  const links: JsonObject[] = [];
  audit.report.tool_feature_cases = evidence;
  audit.report.tool_feature_job_links = links;
  audit.report.tool_feature_terminal_jobs = jobs;
  const absent = async (path: string) => {
    try { await lstat(path); }
    catch (error) { if (object(error).code === 'ENOENT') return; throw error; }
    assert.fail('本轮不应存在目标或事务目录');
  };
  const clean = async (modules: FeaturePackage[]) => {
    for (const item of modules) await absent(join(installRoot, '.transactions', item.module_id));
  };
  const snapshot = async (item: FeaturePackage) => {
    const root = join(installRoot, item.module_id);
    const entryInfo = await lstat(join(root, 'entry.txt'));
    const stateInfo = await lstat(join(root, '.tool-supply-state.json'));
    assert.ok(entryInfo.isFile() && !entryInfo.isSymbolicLink());
    assert.ok(stateInfo.isFile() && !stateInfo.isSymbolicLink());
    return { entry: await readFile(join(root, 'entry.txt')), state: await readFile(join(root, '.tool-supply-state.json')) };
  };
  const installed = async (item: FeaturePackage, manifestVersion: string) => {
    const bytes = await snapshot(item); assert.deepEqual(bytes.entry, item.entry, '安装入口须为合成原字节');
    const state = object(JSON.parse(bytes.state.toString('utf8')));
    assert.equal(state.module_id, item.module_id); assert.equal(state.version, item.version);
    assert.equal(state.sha256, item.checksum); assert.equal(state.manifest_version, manifestVersion);
    assert.equal(state.kind, item.kind); assert.equal(state.feature_key, item.feature_key);
    assert.equal(state.entry_file, 'entry.txt'); assert.equal(state.archive_root, 'bundle');
    return bytes;
  };
  const digest = (bytes: { entry: Buffer; state: Buffer }) => ({ entry_bytes: bytes.entry.length,
    entry_sha256: hash(bytes.entry), state_bytes: bytes.state.length, state_sha256: hash(bytes.state) });
  const traffic = (start: number, downloads: FeaturePackage[], version: string | null, status = 200) => {
    const calls = remote.calls.slice(start);
    assert.deepEqual(calls.map((call) => [call.kind, call.module_id]),
      [['catalog', null], ...downloads.map((item) => ['archive', item.module_id])], '每项只读一次清单且按原顺序下载');
    const catalogCall = calls[0]; assert.ok(catalogCall);
    assert.equal(catalogCall.manifest_version, version); assert.equal(catalogCall.status, status);
    for (const call of calls) { assert.equal(call.method, 'GET'); assert.equal(call.input_bytes, 0); }
    for (const [index, item] of downloads.entries()) {
      const archiveCall = calls[index + 1]; assert.ok(archiveCall);
      assert.equal(archiveCall.response_sha256, hash(item.archive)); assert.equal(archiveCall.status, 200);
    }
    const lastCall = calls.at(-1); assert.ok(lastCall);
    return { first_sequence: catalogCall.sequence, last_sequence: lastCall.sequence,
      catalog_requests: 1, archive_modules: downloads.map((item) => item.module_id) };
  };
  const record = async (job: JsonObject, operation: string, expected: string, requestStart: number) => {
    await audit.recordJob(host, job, expected, operation);
    const record = terminal(job); jobs.push(record);
    links.push({ ...record, requests: host.requests.slice(requestStart) });
    await audit.flush(); assert.equal(job.status, expected); return job;
  };
  const run = async (name: string, input: JsonObject, viaMcp: boolean, expected = 'succeeded') => {
    const operation = `plugin.tool-supply.${name}`; const requestStart = host.requests.length;
    const pending = object(await host.submit(operation, input, viaMcp));
    links.push({ id: pending.id, operation, phase: 'submitted', transport: viaMcp ? 'mcp' : 'http',
      submit_log_id: host.requests[requestStart]?.log_id });
    await audit.flush();
    return record(await host.finished(String(pending.id)), operation, expected, requestStart);
  };
  const rows = (result: JsonObject) => { assert.ok(Array.isArray(result.modules)); return result.modules.map(object); };
  const liveSource = (result: JsonObject) => {
    assert.equal(result.manifest_source, 'live'); assert.equal(result.source_error, null);
    assert.equal(typeof result.manifest_sha256, 'string'); assert.match(String(result.manifest_sha256), /^[0-9a-f]{64}$/);
    return { manifest_source: result.manifest_source, manifest_sha256: result.manifest_sha256, source_error: null };
  };
  const status = (result: JsonObject, key: string, version: string, modules: FeaturePackage[], actions: string[]) => {
    liveSource(result);
    assert.equal(result.feature_key, key); assert.equal(result.manifest_version, version);
    assert.equal(result.source_error, null); assert.equal(result.found, modules.length > 0);
    assert.equal(result.ready, modules.length > 0 && actions.every((action) => action === 'current'));
    const selected = rows(result);
    assert.deepEqual(selected.map((row) => row.module_id), modules.map((item) => item.module_id));
    assert.deepEqual(selected.map((row) => row.action), actions);
    for (const [index, item] of modules.entries()) {
      const selectedRow = selected[index]; assert.ok(selectedRow);
      const action = actions[index]; assert.ok(action);
      assert.equal(selectedRow.kind, 'runtime'); assert.equal(selectedRow.feature_key, key);
      assert.equal(selectedRow.available_version, item.version);
      if (action === 'current') assert.equal(selectedRow.entry_present, true);
    }
  };
  const prepared = (result: JsonObject, key: string, version: string, modules: FeaturePackage[], changed: boolean[]) => {
    assert.deepEqual(result, { ...liveSource(result), feature_key: key, manifest_version: version, ready: true,
      modules: modules.map((item, index) => ({ module_id: item.module_id, version: item.version,
        sha256: item.checksum, changed: changed[index] })) });
  };
  const loaded = async () => {
    const reply = await host.request('/api/v2/plugins'); assert.equal(reply.response.status, 200);
    assert.ok(Array.isArray(reply.json)); assert.equal(reply.json.length, 1);
    const owner = object(reply.json[0]); assert.equal(owner.id, 'tool-supply');
    assert.equal(owner.state, 'loaded'); assert.equal(owner.cleanup_failed, false);
    assert.deepEqual(await host.mcp('deviceforge.list_plugins', {}), reply.json);
    return { id: owner.id, generation: owner.generation, state: owner.state, cleanup_failed: owner.cleanup_failed };
  };
  const stable = async (job: JsonObject) => {
    const count = remote.calls.length; const queried = await host.shared(String(job.id));
    assert.deepEqual(terminal(queried), terminal(job), '恢复查询不能重提、重放或改写原任务终态');
    assert.equal(remote.calls.length, count, '原任务查询不得触发清单读取或下载');
  };

  for (const viaMcp of [false, true]) {
    const transport = viaMcp ? 'mcp' : 'http'; const prefix = `feature-${transport}`;
    const key = viaMcp ? '界'.repeat(42) + '/x' : 'CON/合成运行时:http';
    if (viaMcp) assert.equal(Buffer.byteLength(key), 128);
    const input = { feature_key: key }; const version = `${prefix}-multi`;
    const first = fixture(`${prefix}-first`, key); const second = fixture(`${prefix}-second`, key);
    const ignoredTool = fixture(`${prefix}-tool`, key, '1.0.0', 'tool');
    const ignoredRuntime = fixture(`${prefix}-other`, '合成其他功能');
    const selected = [first, second]; const manifest = [ignoredTool, first, ignoredRuntime, second];
    const unchanged = new Map<string, { entry: Buffer; state: Buffer }>();

    await audit.check(`runtime_feature ${transport}：只匹配 runtime、清单顺序与未安装状态`, async () => {
      remote.catalog(version, manifest); const start = remote.calls.length;
      const result = value(await run('runtime_feature.status', input, viaMcp));
      evidence.push({ case: 'initial_status', transport, ...traffic(start, [], version), feature_key_sha256: hash(key) });
      status(result, key, version, selected, ['install', 'install']);
      for (const item of manifest) await absent(join(installRoot, item.module_id));
      await clean(manifest); await loaded();
    });

    await audit.check(`runtime_feature ${transport}：全部准备、单快照且不安装不匹配模块`, async () => {
      const driftVersion = `${prefix}-drift`; const transitionStart = remote.transitions.length;
      remote.afterDownload(first.module_id, driftVersion, [ignoredTool, ignoredRuntime]);
      const start = remote.calls.length; const job = await run('runtime_feature.prepare', input, viaMcp);
      const calls = traffic(start, selected, version);
      evidence.push({ case: 'single_snapshot', transport, job_id: job.id, ...calls,
        transitions: remote.transitions.slice(transitionStart), installed: [] });
      prepared(value(job), key, version, selected, [true, true]);
      assert.equal(remote.transitions.length, transitionStart + 1);
      const transition = remote.transitions.at(-1); assert.ok(transition);
      const secondDownload = remote.calls[start + 1]; assert.ok(secondDownload);
      assert.equal(transition.sequence, secondDownload.sequence);
      assert.equal(transition.previous_version, version);
      assert.equal(transition.next_version, driftVersion);
      const installedEvidence = evidence.at(-1)!.installed as JsonObject[];
      for (const item of selected) {
        const bytes = await installed(item, version); unchanged.set(item.module_id, bytes);
        installedEvidence.push({ module_id: item.module_id, ...digest(bytes) });
      }
      for (const item of [ignoredTool, ignoredRuntime]) await absent(join(installRoot, item.module_id));
      await clean(manifest);
      const driftStart = remote.calls.length;
      status(value(await run('runtime_feature.status', input, !viaMcp)), key, driftVersion, [], []);
      evidence.push({ case: 'snapshot_source_changed', transport, ...traffic(driftStart, [], driftVersion) });
      await stable(job);
    });

    await audit.check(`runtime_feature ${transport}：ready 与重复准备零下载、原字节不变`, async () => {
      remote.catalog(version, manifest); const statusStart = remote.calls.length;
      status(value(await run('runtime_feature.status', input, !viaMcp)), key, version, selected, ['current', 'current']);
      evidence.push({ case: 'ready_status', transport, ...traffic(statusStart, [], version) });
      const start = remote.calls.length; const job = await run('runtime_feature.prepare', input, viaMcp);
      evidence.push({ case: 'repeat_prepare', transport, job_id: job.id, ...traffic(start, [], version), unchanged: [] });
      prepared(value(job), key, version, selected, [false, false]);
      for (const item of selected) {
        const bytes = await snapshot(item); assert.deepEqual(bytes, unchanged.get(item.module_id));
        (evidence.at(-1)!.unchanged as JsonObject[]).push({ module_id: item.module_id, ...digest(bytes) });
      }
      await clean(manifest); await stable(job); await loaded();
    });

    await audit.check(`runtime_feature ${transport}：未知功能与来源错误不触发下载`, async () => {
      const unknownKey = `合成未知/${transport}`; const unknownInput = { feature_key: unknownKey };
      const statusStart = remote.calls.length;
      status(value(await run('runtime_feature.status', unknownInput, viaMcp)), unknownKey, version, [], []);
      evidence.push({ case: 'unknown_status', transport, ...traffic(statusStart, [], version) });
      const prepareStart = remote.calls.length;
      const unknown = await run('runtime_feature.prepare', unknownInput, viaMcp, 'failed');
      evidence.push({ case: 'unknown_prepare', transport, job_id: unknown.id, ...traffic(prepareStart, [], version) });
      assert.equal(unknown.error, '依赖执行失败：输入或清单无效：清单不存在指定运行时功能'); await stable(unknown);
      for (const mode of ['http', 'json', 'schema'] as const) {
        remote.badCatalog(mode); const start = remote.calls.length;
        const result = value(await run('runtime_feature.status', input, viaMcp));
        evidence.push({ case: 'source_status', transport, mode, ...traffic(start, [], null, mode === 'http' ? 503 : 200),
          source_error_sha256: typeof result.source_error === 'string' ? hash(result.source_error) : null });
        assert.equal(result.feature_key, key); assert.equal(result.manifest_version, null);
        assert.equal(result.manifest_source, null); assert.equal(result.manifest_sha256, null);
        assert.equal(result.found, false); assert.equal(result.ready, false); assert.deepEqual(result.modules, []);
        assert.equal(typeof result.source_error, 'string'); assert.ok(String(result.source_error).length > 0);
        assert.ok(!String(result.source_error).includes('synthetic-source-marker'));
        assert.ok(!String(result.source_error).includes(remote.base));
        assert.ok(!String(result.source_error).includes(installRoot));
        const failedStart = remote.calls.length;
        const failed = await run('runtime_feature.prepare', input, viaMcp, 'failed');
        evidence.push({ case: 'source_prepare', transport, mode, job_id: failed.id,
          ...traffic(failedStart, [], null, mode === 'http' ? 503 : 200) });
        assert.equal(typeof failed.error, 'string'); assert.ok(!String(failed.error).includes('synthetic-source-marker'));
        await stable(failed); await loaded();
      }
      for (const item of selected) assert.deepEqual(await snapshot(item), unchanged.get(item.module_id));
      await clean(manifest);
    });

    await audit.check(`runtime_feature ${transport}：第二模块失败、首模块保留与第三模块未下载`, async () => {
      const partialKey = `合成部分失败/${transport}`; const partialVersion = `${prefix}-partial`;
      const firstPartial = fixture(`${prefix}-partial-first`, partialKey);
      const oldSecond = fixture(`${prefix}-partial-second`, partialKey);
      const nextSecond = fixture(oldSecond.module_id, partialKey, '2.0.0'); nextSecond.checksum = '0'.repeat(64);
      const thirdPartial = fixture(`${prefix}-partial-third`, partialKey);
      const seedVersion = `${prefix}-seed`; remote.catalog(seedVersion, [oldSecond]);
      const seedStart = remote.calls.length;
      await run('install', { module_id: oldSecond.module_id }, !viaMcp);
      const original = await installed(oldSecond, seedVersion);
      evidence.push({ case: 'partial_seed', transport, ...traffic(seedStart, [oldSecond], seedVersion),
        module_id: oldSecond.module_id, ...digest(original) });
      const modules = [firstPartial, nextSecond, thirdPartial]; remote.catalog(partialVersion, modules);
      const start = remote.calls.length;
      const failed = await run('runtime_feature.prepare', { feature_key: partialKey }, viaMcp, 'failed');
      evidence.push({ case: 'partial_failure', transport, job_id: failed.id,
        ...traffic(start, [firstPartial, nextSecond], partialVersion), old: digest(original) });
      assert.equal(failed.error, '依赖执行失败：下载文件 SHA-256 不匹配');
      const committed = await installed(firstPartial, partialVersion); const retained = await snapshot(oldSecond);
      assert.deepEqual(retained, original); await absent(join(installRoot, thirdPartial.module_id)); await clean(modules);
      evidence.at(-1)!.first_committed = digest(committed); evidence.at(-1)!.second_retained = digest(retained);
      evidence.at(-1)!.third_absent = true; evidence.at(-1)!.transactions_clean = true;
      const queryStart = remote.calls.length;
      status(value(await run('runtime_feature.status', { feature_key: partialKey }, !viaMcp)), partialKey,
        partialVersion, modules, ['current', 'update', 'install']);
      evidence.push({ case: 'partial_status', transport, ...traffic(queryStart, [], partialVersion) });
      await stable(failed); await loaded();
    });

    await audit.check(`runtime_feature ${transport}：在途 status 为 Busy、取消无损且插件仍可调用`, async () => {
      const cancelKey = `合成取消/${transport}`; const cancelInput = { feature_key: cancelKey };
      const cancelVersion = `${prefix}-cancel`;
      const cancelFirst = fixture(`${prefix}-cancel-first`, cancelKey);
      const cancelOld = fixture(`${prefix}-cancel-second`, cancelKey);
      const cancelNext = fixture(cancelOld.module_id, cancelKey, '2.0.0');
      const cancelThird = fixture(`${prefix}-cancel-third`, cancelKey);
      const modules = [cancelFirst, cancelNext, cancelThird]; const seedVersion = `${prefix}-cancel-seed`;
      remote.catalog(seedVersion, [cancelOld]); const seedStart = remote.calls.length;
      await run('install', { module_id: cancelOld.module_id }, !viaMcp);
      const original = await installed(cancelOld, seedVersion);
      evidence.push({ case: 'cancel_seed', transport, ...traffic(seedStart, [cancelOld], seedVersion),
        module_id: cancelOld.module_id, ...digest(original) });
      remote.catalog(cancelVersion, modules); remote.holdDownload(cancelNext.module_id);
      const ownerBefore = await loaded(); const start = remote.calls.length;
      const operation = 'plugin.tool-supply.runtime_feature.prepare'; const requestStart = host.requests.length;
      const pending = object(await host.submit(operation, cancelInput, viaMcp));
      links.push({ id: pending.id, operation, phase: 'submitted', transport,
        submit_log_id: host.requests[requestStart]?.log_id }); await audit.flush();
      const latch = await remote.waitDownload(cancelNext.module_id); assert.ok(latch);
      const heldJob = await host.shared(String(pending.id));
      const committed = await installed(cancelFirst, cancelVersion);
      const gateEvidence: JsonObject = { case: 'cancel_gate', transport, job_id: pending.id,
        ...traffic(start, [cancelFirst, cancelNext], cancelVersion), gate_sequence: latch.sequence,
        gate_finished: latch.finished, first_committed: digest(committed), old_second: digest(original), owner_before: ownerBefore };
      evidence.push(gateEvidence); await audit.flush();
      assert.equal(heldJob.status, 'running'); assert.equal(latch.finished, false); assert.equal(latch.closed, false);
      const transactionInfo = await lstat(join(installRoot, '.transactions', cancelNext.module_id));
      assert.ok(transactionInfo.isDirectory() && !transactionInfo.isSymbolicLink());
      assert.deepEqual(await snapshot(cancelOld), original); await absent(join(installRoot, cancelThird.module_id));
      const busyStart = remote.calls.length;
      const busy = await run('runtime_feature.status', cancelInput, !viaMcp, 'failed');
      const busyCalls = remote.calls.slice(busyStart);
      gateEvidence.busy_job_id = busy.id; gateEvidence.busy_source_sequences = busyCalls.map((call) => call.sequence);
      await audit.flush(); assert.equal(busy.error, '依赖执行失败：模块正在安装或移除', '合法在途事务不得被标记为 cleanup_failed');
      assert.ok(busyCalls.length <= 1 && busyCalls.every((call) => call.kind === 'catalog'), '在途查询不得下载模块');
      assert.deepEqual(await loaded(), ownerBefore, '在途查询不能使插件 draining 或撤销公开贡献');
      assert.equal(latch.finished, false); assert.equal(latch.closed, false);
      const beforeCancel = remote.calls.length;
      await host.cancel(String(pending.id), !viaMcp);
      const cancelled = await record(await host.finished(String(pending.id)), operation, 'cancelled', requestStart);
      await remote.downloadClosed(cancelNext.module_id);
      await poll(async () => {
        try { await lstat(join(installRoot, '.transactions', cancelNext.module_id)); return false; }
        catch (error) { if (object(error).code === 'ENOENT') return true; throw error; }
      }, Boolean, '取消后当前模块事务清理');
      const retained = await snapshot(cancelOld); assert.deepEqual(retained, original);
      assert.deepEqual(await snapshot(cancelFirst), committed);
      await absent(join(installRoot, cancelThird.module_id)); await clean(modules);
      assert.equal(remote.calls.length, beforeCancel, '取消和等待清理不得自动重试源请求');
      assert.equal(latch.finished, false); assert.equal(latch.closed, true);
      const ownerAfter = await loaded(); assert.deepEqual(ownerAfter, ownerBefore);
      evidence.push({ case: 'cancelled_clean', transport, job_id: cancelled.id, gate_sequence: latch.sequence,
        response_finished: latch.finished, connection_closed: latch.closed, first_retained: digest(committed),
        second_retained: digest(retained), third_absent: true, transactions_clean: true, owner_after: ownerAfter });
      const queryStart = remote.calls.length;
      status(value(await run('runtime_feature.status', cancelInput, viaMcp)), cancelKey, cancelVersion, modules,
        ['current', 'update', 'install']);
      evidence.push({ case: 'cancelled_status', transport, ...traffic(queryStart, [], cancelVersion) });
      await stable(cancelled); await stable(busy);
      remote.catalog(cancelVersion, modules); const recoveryStart = remote.calls.length;
      const recovered = await run('runtime_feature.prepare', cancelInput, viaMcp);
      evidence.push({ case: 'explicit_new_job', transport, cancelled_job_id: cancelled.id, new_job_id: recovered.id,
        ...traffic(recoveryStart, [cancelNext, cancelThird], cancelVersion), installed: [] });
      assert.notEqual(recovered.id, cancelled.id);
      prepared(value(recovered), cancelKey, cancelVersion, modules, [false, true, true]);
      for (const item of modules) {
        const bytes = await installed(item, cancelVersion);
        (evidence.at(-1)!.installed as JsonObject[]).push({ module_id: item.module_id, ...digest(bytes) });
      }
      assert.deepEqual(await snapshot(cancelFirst), committed); await clean(modules);
      await stable(cancelled); await stable(recovered); assert.deepEqual(await loaded(), ownerBefore);
    });
  }
  return { jobs };
}

export async function queryToolFeatureJobs(host: Host, remote: ToolFeatureSource, audit: Reporter, jobs: ToolFeatureJobEvidence[]) {
  const before = remote.calls.length; const queried: JsonObject[] = [];
  audit.report.tool_feature_recovered_queries = queried;
  for (const expected of jobs) {
    const requestStart = host.requests.length; const recovered = await host.shared(expected.id);
    const actual = terminal(recovered);
    queried.push({ ...actual, requests: host.requests.slice(requestStart) });
    await audit.flush(); assert.deepEqual(actual, expected, '宿主重启后仅恢复查询原任务，终态及正文摘要须不变');
  }
  assert.equal(remote.calls.length, before, '宿主重启与任务恢复查询不得读取来源、下载或重提业务');
  audit.report.tool_feature_recovered_source_unchanged = true;
}
