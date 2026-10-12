import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, object, sleep, type Host, type JsonObject } from './six-business-support.ts';
import { identities } from './ordinary-business-report.ts';
import type { CachePackage } from './ordinary-tool-cache-source.ts';

export function cacheTerminal(job: JsonObject) {
  return { id: String(job.id), operation: String(job.operation), status: String(job.status),
    input_sha256: hash(JSON.stringify(job.input ?? null)), result_sha256: hash(JSON.stringify(job.result ?? null)),
    error_sha256: typeof job.error === 'string' ? hash(job.error) : null };
}
export type CacheTerminal = ReturnType<typeof cacheTerminal>;

export function cacheMeta(result: JsonObject, source: 'live' | 'cache' | null, version: string | null, base: string, installRoot: string) {
  assert.equal(result.manifest_source, source); assert.equal(result.manifest_version, version);
  if (source === null) assert.equal(result.manifest_sha256, null);
  else { assert.equal(typeof result.manifest_sha256, 'string'); assert.match(String(result.manifest_sha256), /^[0-9a-f]{64}$/); }
  if (source === 'live') assert.equal(result.source_error, null);
  else {
    assert.equal(typeof result.source_error, 'string'); assert.ok(String(result.source_error).length > 0);
    for (const forbidden of [base, installRoot, 'synthetic-cache-marker']) assert.ok(!String(result.source_error).includes(forbidden));
  }
  return { manifest_source: source, manifest_version: version, manifest_sha256: result.manifest_sha256,
    source_error_sha256: typeof result.source_error === 'string' ? hash(result.source_error) : null };
}

export async function absent(path: string) {
  try { await lstat(path); }
  catch (error) { if (object(error).code === 'ENOENT') return; throw error; }
  assert.fail('本轮目标不应存在');
}

export async function installed(installRoot: string, item: CachePackage, manifestVersion: string) {
  const directory = join(installRoot, item.module_id);
  for (const name of ['entry.txt', '.tool-supply-state.json']) {
    const metadata = await lstat(join(directory, name)); assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
  }
  const entry = await readFile(join(directory, 'entry.txt'));
  const stateBytes = await readFile(join(directory, '.tool-supply-state.json'));
  const state = object(JSON.parse(stateBytes.toString('utf8')));
  assert.deepEqual(entry, item.entry); assert.equal(state.module_id, item.module_id);
  assert.equal(state.version, item.version); assert.equal(state.sha256, item.checksum);
  assert.equal(state.manifest_version, manifestVersion); assert.equal(state.kind, item.kind);
  assert.equal(state.feature_key, item.feature_key); assert.equal(state.entry_file, 'entry.txt');
  assert.equal(state.archive_root, 'bundle');
  await absent(join(installRoot, '.transactions', item.module_id));
  return { entry_sha256: hash(entry), entry_bytes: entry.length, state_sha256: hash(stateBytes), state_bytes: stateBytes.length };
}

export function ownedPath(root: string, path: string) {
  const distance = relative(resolve(root), resolve(path));
  assert.ok(distance && distance !== '..' && !distance.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(distance), '故障注入仅限本轮目录');
  return resolve(path);
}

export async function cacheSnapshot(root: string, installRoot: string, label: string, expected: CachePackage[], manifestSha: unknown, sourceUrl: string) {
  const directory = ownedPath(root, join(installRoot, '.manifest-cache'));
  const directoryInfo = await lstat(directory); assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink());
  const files: string[] = [];
  const walk = async (current: string) => {
    for (const name of await readdir(current)) {
      const path = ownedPath(root, join(current, name)); const info = await lstat(path);
      assert.equal(info.isSymbolicLink(), false, '正常缓存不应含链接');
      if (info.isDirectory()) await walk(path);
      else { assert.ok(info.isFile(), '正常缓存条目须为普通文件'); files.push(path); }
    }
  };
  await walk(directory);
  const snapshots: { path: string; bytes: Buffer; envelope: JsonObject; manifest: JsonObject }[] = [];
  const findManifest = (value: unknown): JsonObject | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = object(value);
    if (typeof record.manifestVersion === 'string' && Array.isArray(record.modules)) return record;
    for (const child of Object.values(record)) { const found = findManifest(child); if (found) return found; }
    return undefined;
  };
  for (const path of files) {
    const info = await lstat(path); assert.ok(info.size <= 8388608, '缓存证据读取须有界');
    const bytes = await readFile(path);
    let decoded: unknown;
    try { decoded = JSON.parse(bytes.toString('utf8')); } catch { continue; }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) continue;
    const envelope = object(decoded); const manifest = findManifest(envelope);
    if (envelope.schema_version === 1 && manifest) snapshots.push({ path, bytes, envelope, manifest });
  }
  assert.equal(snapshots.length, 1, '该固定URL应仅有一个完整缓存封装');
  const snapshot = snapshots[0]; assert.ok(snapshot);
  assert.ok(Array.isArray(snapshot.manifest.modules));
  const modules = snapshot.manifest.modules.map(object);
  assert.deepEqual(modules.map((item) => [item.name, item.version, item.sha256]), expected.map((item) => [item.module_id, item.version, item.checksum]));
  assert.equal(snapshot.envelope.manifest_sha256, manifestSha, '封装必须保存公开清单摘要');
  const sourceSha = hash(new URL(sourceUrl).href);
  assert.equal(snapshot.envelope.source_sha256, sourceSha, '固定规范URL身份应在封装中');
  const preservation = join(root, 'cache-originals', label); await mkdir(preservation, { recursive: true });
  await copyFile(snapshot.path, join(preservation, 'envelope.json'));
  return { path: snapshot.path, bytes: snapshot.bytes,
    evidence: { label, snapshot_path: relative(root, snapshot.path).replaceAll('\\', '/'),
      preserved_path: relative(root, join(preservation, 'envelope.json')).replaceAll('\\', '/'),
      bytes: snapshot.bytes.length, envelope_sha256: hash(snapshot.bytes), schema_version: snapshot.envelope.schema_version,
      envelope_fields: Object.keys(snapshot.envelope), manifest_sha256: manifestSha, normalized_source_url_sha256: sourceSha,
      module_inputs: expected.map((item) => ({ module_id: item.module_id, version: item.version, sha256: item.checksum })),
      independent_canonical_recomputed: false } };
}

export async function originalBudgetTerminal(host: Host, id: string, started: number, budget: number) {
  const end = started + budget + 15000;
  while (Date.now() < end) {
    const reply = await host.request(`/api/v2/jobs/${id}`); assert.equal(reply.response.status, 200);
    const job = object(reply.json);
    if (['succeeded', 'failed', 'cancelled'].includes(String(job.status))) return job;
    await sleep(250);
  }
  throw new Error('原执行预算及有界清理等待后任务仍无终态');
}

export async function persistedEvidence(root: string, jobs: CacheTerminal[], submissionLogIds: string[]) {
  const database = new DatabaseSync(join(root, 'data/jobs.db'), { readOnly: true });
  const stored: CacheTerminal[] = [];
  try {
    for (const expected of jobs) {
      const row = object(database.prepare('SELECT body FROM jobs WHERE id=?').get(expected.id));
      assert.equal(typeof row.body, 'string'); const actual = cacheTerminal(object(JSON.parse(String(row.body))));
      stored.push(actual); assert.deepEqual(actual, expected, 'SQLite 原Job终态与服务证据一致');
    }
    const count = object(database.prepare('SELECT COUNT(*) AS count FROM jobs').get());
    assert.equal(Number(count.count), jobs.length, '恢复查询不得另建任务');
  } finally { database.close(); }
  const logs = join(root, 'data/logs'); const files = (await readdir(logs)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(files.length > 0);
  const records: JsonObject[] = [];
  for (const name of files) {
    for (const line of (await readFile(join(logs, name), 'utf8')).split('\n').filter(Boolean)) records.push(object(JSON.parse(line)));
  }
  const serialized = records.map((record) => JSON.stringify(record));
  for (const id of submissionLogIds) assert.ok(serialized.some((record) => record.includes(id)), '提交响应日志ID须落入宿主日志');
  const links = jobs.map((job) => {
    const record = records.find((record) => record.fields !== undefined && object(record.fields).message === '插件调用结束' && JSON.stringify(record).includes(job.id));
    assert.ok(record, '每个真实任务须有插件结束日志'); const span = object(record.span);
    assert.equal(typeof span.plugin_request_id, 'string');
    return { job_id: job.id, plugin_request_id: span.plugin_request_id, record_sha256: hash(JSON.stringify(record)) };
  });
  assert.equal(new Set(links.map((item) => item.plugin_request_id)).size, jobs.length, '独立任务须为不同插件调用');
  return { sqlite_jobs: stored, log_job_links: links, submission_log_ids: submissionLogIds,
    log_files: await identities(root, [], files.map((name) => join(logs, name))),
    log_record_count: records.length, database_files: await identities(root, [], [join(root, 'data/jobs.db')]) };
}
