import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

function values(record) {
  const found = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') visit(item);
      else if (typeof item === 'string') {
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(item);
      }
    }
  };
  visit(record.fields);
  visit(record.span);
  visit(record.spans);
  return found;
}
// 与设备公开Job同日志关联；清理失败必须核cleanup_failed，不缩成普通依赖失败。
export async function verifyLogs(directory, host, report) {
  const root = join(directory, 'data/logs'),
    responseIds = new Set(),
    calls = new Map(),
    ends = new Map(),
    files = [];
  let bytes = 0,
    records = 0,
    stops = 0;
  const entries = await readdir(root, { withFileTypes: true });
  assert.ok(entries.length <= 256);
  for (const item of entries.filter((item) => item.isFile() && item.name.endsWith('.jsonl'))) {
    const path = join(root, item.name),
      size = (await stat(path)).size;
    bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    files.push(await fileIdentity(path));
    let lineNumber = 0;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      lineNumber++;
      if (!line.trim()) continue;
      const record = JSON.parse(line),
        known = values(record),
        message = record.fields?.message;
      records++;
      for (const found of known.values())
        for (const id of found) if (host.client.logIds.has(id)) responseIds.add(id);
      if (message === '宿主运行已结束') stops++;
      for (const job of report.jobs) {
        if (!known.get('job_id')?.has(job.job_id) || !known.get('plugin_id')?.has('android-device'))
          continue;
        const ids = [...(known.get('plugin_request_id') ?? [])];
        if (message === '插件调用开始') {
          assert.equal(ids.length, 1);
          assert.match(ids[0], /^[a-f\d-]{36}$/);
          assert.ok(known.get('log_id')?.has(job.submit_log_id));
          assert.ok(!calls.has(job.job_id));
          calls.set(job.job_id, {
            job_id: job.job_id,
            plugin_request_id: ids[0],
            submit_log_id: job.submit_log_id,
            path,
            line: lineNumber,
          });
        }
        if (message === '插件调用结束') {
          assert.equal(ids.length, 1);
          assert.ok(!ends.has(job.job_id));
          const expected =
            job.expected_end_code ??
            (job.expected_status === 'succeeded'
              ? 'ok'
              : job.expected_status === 'cancelled'
                ? 'cancelled'
                : 'dependency_failed');
          assert.equal(record.fields.code, expected, 'PROFILE-EXACT-PLUGIN-END-CODE');
          ends.set(job.job_id, {
            plugin_request_id: ids[0],
            code: record.fields.code,
            path,
            line: lineNumber,
          });
        }
      }
    }
  }
  assert.deepEqual(
    [...responseIds].sort(),
    [...host.client.logIds].sort(),
    'PROFILE-ALL-RESPONSE-LOG-IDS',
  );
  assert.equal(calls.size, report.jobs.length);
  assert.equal(ends.size, report.jobs.length);
  const unique = new Set();
  for (const job of report.jobs) {
    const start = calls.get(job.job_id),
      end = ends.get(job.job_id);
    assert.equal(start.plugin_request_id, end.plugin_request_id);
    assert.ok(!unique.has(start.plugin_request_id));
    unique.add(start.plugin_request_id);
    job.plugin_call = { ...start, end };
  }
  assert.ok(stops >= 1);
  report.logging = {
    response_ids: [...responseIds].sort(),
    jobs: report.jobs.length,
    per_job_call_relations: [...calls.values()],
    persisted_records: records,
    normal_host_stop_records: stops,
    files,
    boundary: '逐项Job/log_id/request_id及真实结束code配对；工具argv与原OS句柄另证，未截获协议帧',
  };
}
