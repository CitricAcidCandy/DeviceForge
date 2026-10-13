import assert from 'node:assert/strict';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
export { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
export { inputManifest } from '../android-device-smoke/evidence.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
export async function writeJson(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), handle = await open(path, 'w');
  try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes.subarray(offset, offset + 4096)); assert.ok(result.bytesWritten > 0); offset += result.bytesWritten; } }
  finally { await handle.close(); }
}
function values(record, key) {
  const found = new Set();
  function visit(value) { if (!value || typeof value !== 'object') return; for (const [name, item] of Object.entries(value)) {
    if (name === key && typeof item === 'string') found.add(item); else if (item && typeof item === 'object') visit(item);
  } }
  visit(record.fields); visit(record.span); visit(record.spans); return found;
}
export async function verifyLogs(directory, host, report) {
  const root = join(directory, 'data', 'logs'), names = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort();
  assert.ok(names.length > 0 && names.length <= 256); const found = new Set(), starts = new Map(), ends = new Map();
  let bytes = 0, records = 0, stops = 0; report.log_files = [];
  for (const name of names) {
    const path = join(root, name), size = (await stat(path)).size; bytes += size; assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    const identity = await fileIdentity(path); report.log_files.push(identity);
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)).split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue; const record = JSON.parse(lines[index]); records++;
      for (const id of values(record, 'log_id')) if (host.client.logIds.has(id)) found.add(id);
      const message = record.fields?.message; if (message === '宿主运行已结束') stops++;
      if (!values(record, 'plugin_id').has('spreadsheet') || !['插件调用开始', '插件调用结束'].includes(message)) continue;
      const job = report.jobs.find(entry => values(record, 'job_id').has(entry.id)); assert.ok(job, 'SS-LOG-KNOWN-JOB');
      const collection = message === '插件调用开始' ? starts : ends; assert.ok(!collection.has(job.id));
      const requestIds = [...values(record, 'plugin_request_id')]; assert.equal(requestIds.length, 1); assert.match(requestIds[0], /^[a-f\d-]{36}$/);
      assert.ok(values(record, 'log_id').has(job.submit_log_id));
      collection.set(job.id, { path, line: index + 1, plugin_request_id: requestIds[0], code: record.fields.code });
    }
    assert.deepEqual(await fileIdentity(path), identity);
  }
  assert.deepEqual([...found].sort(), [...host.client.logIds].sort()); assert.ok(stops > 0);
  assert.equal(starts.size, report.jobs.length); assert.equal(ends.size, report.jobs.length);
  for (const job of report.jobs) assert.equal(starts.get(job.id).plugin_request_id, ends.get(job.id).plugin_request_id);
  report.logging = { records, response_ids: [...found].sort(), normal_stop_records: stops, jobs: report.jobs.map(job => ({ id: job.id, start: starts.get(job.id), end: ends.get(job.id) })) };
}
export function failure(report, error, stage) {
  report.passed = false;
  const value = { stage, name: error.name, code: error.code, operator: error.operator, locations: String(error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6) };
  const label = String(error.message ?? '').split('\n')[0]; if (label.startsWith('SS-') && label.length <= 180) value.assertion_label = label;
  if (report.failure) { report.secondary_errors ??= []; report.secondary_errors.push(value); } else report.failure = value;
}
