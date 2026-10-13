import assert from 'node:assert/strict';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
export { inputManifest } from '../android-device-smoke/evidence.mjs';
export { fileIdentity };

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
function fieldsOf(record) {
  const fields = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') visit(item);
      else if (typeof item === 'string') {
        if (!fields.has(key)) fields.set(key, new Set());
        fields.get(key).add(item);
      }
    }
  }
  visit(record.fields); visit(record.span); visit(record.spans); return fields;
}
export function failure(report, error, stage) {
  report.passed = false;
  const detail = { stage, name: error.name, code: error.code, operator: error.operator };
  const label = String(error.message ?? '').split('\n')[0];
  if (label.startsWith('AD-OBS-') && label.length <= 180) detail.assertion_label = label;
  detail.locations = String(error.stack ?? '').split('\n')
    .filter(line => /^\s+at /.test(line) && /android-device-observation-smoke/.test(line)).slice(0, 8);
  if (report.failure) { report.secondary_errors ??= []; report.secondary_errors.push(detail); }
  else report.failure = detail;
}

// 仅索引本次独立目录，保留原件；有界逐批写入，避免单次巨大文件写操作。
export async function writeJsonBatches(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), handle = await open(path, 'w');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes.subarray(offset, Math.min(offset + 4096, bytes.length)));
      assert.ok(result.bytesWritten > 0, 'AD-OBS-REPORT-WRITE-PROGRESS'); offset += result.bytesWritten;
    }
  } finally { await handle.close(); }
}
export async function retain(directory, report) {
  report.retained_files = []; let entries = 0;
  async function visit(folder, depth = 0) {
    assert.ok(depth <= 12, 'AD-OBS-RETENTION-DEPTH');
    for (const item of await readdir(folder, { withFileTypes: true })) {
      assert.ok(++entries <= 8192, 'AD-OBS-RETENTION-ENTRIES');
      assert.ok(!item.isSymbolicLink(), 'AD-OBS-RETENTION-NO-SYMLINK');
      const path = join(folder, item.name);
      if (item.isDirectory()) await visit(path, depth + 1);
      else if (item.isFile() && !['report.json', 'checkpoint.json'].includes(item.name)) report.retained_files.push(await fileIdentity(path));
    }
  }
  await visit(directory); report.retention_budget = { entries: 8192, depth: 12, actual_entries: entries };
  report.temporary_retained = directory; report.temporary_removed = false;
  await writeJsonBatches(join(directory, 'checkpoint.json'), report);
}
export async function verifyLogs(directory, host, report) {
  const folder = join(directory, 'data', 'logs');
  const names = (await readdir(folder)).filter(name => name.endsWith('.jsonl')).sort();
  assert.ok(names.length > 0 && names.length <= 256, 'AD-OBS-LOG-FILE-COUNT');
  const sessions = new Map(report.sessions.map(session => [session.id, session]));
  const starts = new Map(), ends = new Map(), responses = new Set();
  report.log_files = []; let bytes = 0, stops = 0;
  for (const name of names) {
    const path = join(folder, name), size = (await stat(path)).size;
    bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024, 'AD-OBS-LOG-BYTES');
    const identity = await fileIdentity(path); report.log_files.push(identity);
    const lines = (await readFile(path, 'utf8')).split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      const record = JSON.parse(lines[index]), fields = fieldsOf(record), message = record.fields?.message;
      for (const id of fields.get('log_id') ?? []) if (host.client.logIds.has(id)) responses.add(id);
      if (message === '宿主运行已结束') stops++;
      if (!fields.get('plugin_id')?.has('android-device') || !['插件调用开始', '插件调用结束'].includes(message)) continue;
      const requestIds = [...(fields.get('plugin_request_id') ?? [])];
      assert.equal(requestIds.length, 1, 'AD-OBS-PLUGIN-REQUEST-ID'); assert.match(requestIds[0], uuid);
      const sessionIds = [...(fields.get('session_id') ?? [])];
      const relation = { plugin_request_id: requestIds[0], path, line: index + 1, timestamp: record.timestamp };
      if (sessionIds.length) {
        assert.equal(sessionIds.length, 1, 'AD-OBS-BACKGROUND-SINGLE-SESSION');
        const session = sessions.get(sessionIds[0]); assert.ok(session, 'AD-OBS-BACKGROUND-KNOWN-SESSION');
        assert.deepEqual([...(fields.get('source_plugin_id') ?? [])], [session.source.plugin_id], 'AD-OBS-LOG-SOURCE-PLUGIN');
        assert.deepEqual([...(fields.get('source_generation') ?? [])], [session.source.generation], 'AD-OBS-LOG-SOURCE-GENERATION');
        Object.assign(relation, { session_id: session.id, source: structuredClone(session.source) });
      }
      const inventory = message === '插件调用开始' ? starts : ends;
      assert.ok(!inventory.has(requestIds[0]), 'AD-OBS-PLUGIN-LOG-NO-DUPLICATE');
      if (message === '插件调用结束') {
        const codes = [...(fields.get('code') ?? [])]; assert.equal(codes.length, 1);
        assert.ok(['ok', 'cancelled'].includes(codes[0]), 'AD-OBS-PLUGIN-COMPLETE-CODE'); relation.code = codes[0];
      }
      inventory.set(requestIds[0], relation);
    }
    assert.deepEqual(await fileIdentity(path), identity, 'AD-OBS-LOG-STABLE-AFTER-SHUTDOWN');
  }
  assert.deepEqual([...responses].sort(), [...host.client.logIds].sort(), 'AD-OBS-ALL-RESPONSE-LOG-IDS');
  assert.deepEqual([...starts.keys()].sort(), [...ends.keys()].sort(), 'AD-OBS-PLUGIN-LOG-PAIRS');
  report.plugin_calls = [...starts.values()].map(start => {
    const end = ends.get(start.plugin_request_id);
    assert.equal(end.session_id, start.session_id, 'AD-OBS-LOG-SESSION-IMMUTABLE');
    assert.deepEqual(end.source, start.source, 'AD-OBS-LOG-SOURCE-IMMUTABLE');
    return { ...start, end };
  });
  for (const session of report.sessions) assert.ok(report.plugin_calls.some(call => call.session_id === session.id), 'AD-OBS-EACH-SESSION-CALL-LOG');
  assert.ok(report.plugin_calls.some(call => call.session_id === report.lifecycle.interrupted.id && call.end.code === 'cancelled'), 'AD-OBS-INFLIGHT-CANCEL-LOG');
  assert.ok(stops >= 1, 'AD-OBS-HOST-EXIT-LOG');
  report.response_log_ids = [...responses].sort(); report.host_stop_logs = stops;
  report.checks.push({ name: '全部响应日志ID、后台会话/固定代次与调用起止配对正常落盘', passed: true });
}
