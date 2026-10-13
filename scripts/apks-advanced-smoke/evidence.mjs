import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

function values(record) {
  const found = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      if (item && typeof item === 'object') visit(item);
      else if (typeof item === 'string') {
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(item);
      }
    }
  };
  visit(record.fields); visit(record.span); visit(record.spans); return found;
}

export async function logs(context) {
  const root = join(context.directory, 'data/logs'), files = [], ids = new Set(), calls = new Map(), ends = new Map();
  let records = 0, bytes = 0, stops = 0;
  for (const name of (await readdir(root)).filter(value => value.endsWith('.jsonl'))) {
    const path = join(root, name), size = (await stat(path)).size;
    bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    files.push(await fileIdentity(path));
    const text = await readFile(path, 'utf8');
    for (const marker of ['synthetic extraction complete', 'installation complete', 'feature:public']) assert.ok(!text.includes(marker));
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line), known = values(parsed), message = parsed.fields?.message;
      records++;
      for (const found of known.values()) for (const id of found) if (context.host.client.logIds.has(id)) ids.add(id);
      if (message === '宿主运行已结束') stops++;
      if (!['插件调用开始', '插件调用结束'].includes(message)) continue;
      const entry = context.report.jobs.find(value => known.get('job_id')?.has(value.job_id));
      if (!entry) continue;
      assert.ok(known.get('plugin_id')?.has(entry.plugin_id));
      const requestIds = [...(known.get('plugin_request_id') ?? [])];
      assert.equal(requestIds.length, 1);
      const collection = message === '插件调用开始' ? calls : ends;
      assert.ok(!collection.has(entry.job_id));
      if (collection === calls) assert.ok(known.get('log_id')?.has(entry.submit_log_id));
      else assert.equal(parsed.fields.code, entry.expected_status === 'succeeded' ? 'ok' : entry.expected_status === 'cancelled' ? 'cancelled' : 'dependency_failed');
      collection.set(entry.job_id, { path, line: index + 1, request_id: requestIds[0], code: parsed.fields.code });
    }
  }
  assert.equal(calls.size, context.report.jobs.length);
  assert.equal(ends.size, context.report.jobs.length);
  assert.deepEqual([...ids].sort(), [...context.host.client.logIds].sort());
  for (const entry of context.report.jobs) assert.equal(calls.get(entry.job_id).request_id, ends.get(entry.job_id).request_id);
  assert.ok(stops > 0);
  context.report.logging = { records, files, response_ids: [...ids].sort(), normal_stop_records: stops,
    jobs: context.report.jobs.map(entry => ({ job_id: entry.job_id, start: calls.get(entry.job_id), end: ends.get(entry.job_id) })) };
  context.report.checks.push({ name: '全部响应/Job/request关联落盘且私有内容不进普通日志', passed: true });
}

export function failure(report, error, stage) {
  const detail = { name: error.name, code: error.code, operator: error.operator,
    message: String(error.message).split('\n')[0].slice(0, 200),
    locations: String(error.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6) };
  report.passed = false;
  report.failure_stage ??= stage;
  if (report.failure) { report.secondary_failures ??= []; report.secondary_failures.push(detail); }
  else report.failure = detail;
}
