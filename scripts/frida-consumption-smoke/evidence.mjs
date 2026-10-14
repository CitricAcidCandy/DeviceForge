import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { inputManifest } from '../harmony-device-smoke/evidence.mjs';

function fieldValues(record, key) {
  const found = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      if (name === key && typeof item === 'string') found.add(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(record.fields);
  visit(record.span);
  visit(record.spans);
  return found;
}

export async function verifyLogs(directory, host, report) {
  const found = new Set(),
    starts = new Map(),
    ends = new Map(),
    files = [];
  let records = 0,
    stops = 0,
    bytes = 0;
  const root = join(directory, 'data/logs');
  for (const name of (await readdir(root)).filter((name) => name.endsWith('.jsonl'))) {
    const path = join(root, name),
      identity = await fileIdentity(path);
    bytes += identity.bytes;
    assert.ok(identity.bytes <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    files.push(identity);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    for (const marker of [
      'frida-server-fixture',
      '__DEVICEFORGE_NOTICE__',
      '__DEVICEFORGE_HOOK__',
      'console-message',
      '授权样例',
    ])
      assert.ok(!text.includes(marker));
    for (const [offset, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      const record = JSON.parse(line),
        ids = fieldValues(record, 'log_id');
      records++;
      for (const id of ids) if (host.client.logIds.has(id)) found.add(id);
      const message = record.fields?.message;
      if (message === '宿主运行已结束') stops++;
      if (!fieldValues(record, 'plugin_id').has('frida')) continue;
      const job = report.jobs.find((entry) => fieldValues(record, 'job_id').has(entry.id));
      if (!job) continue;
      const collection =
        message === '插件调用开始' ? starts : message === '插件调用结束' ? ends : undefined;
      if (!collection) continue;
      assert.ok(!collection.has(job.id));
      assert.ok(ids.has(job.submit_log_id));
      const requestIds = [...fieldValues(record, 'plugin_request_id')];
      assert.equal(requestIds.length, 1);
      assert.match(requestIds[0], /^[a-f\d-]{36}$/);
      if (collection === ends)
        assert.equal(record.fields.code, job.status === 'cancelled' ? 'cancelled' : 'ok');
      collection.set(job.id, {
        path,
        line: offset + 1,
        log_id: job.submit_log_id,
        plugin_request_id: requestIds[0],
        code: record.fields.code,
      });
    }
  }
  assert.deepEqual([...found].sort(), [...host.client.logIds].sort());
  assert.equal(starts.size, report.jobs.length);
  assert.equal(ends.size, report.jobs.length);
  assert.ok(stops > 0);
  const requestIds = new Set();
  for (const job of report.jobs) {
    const start = starts.get(job.id),
      end = ends.get(job.id);
    assert.equal(start.plugin_request_id, end.plugin_request_id);
    assert.ok(!requestIds.has(start.plugin_request_id));
    requestIds.add(start.plugin_request_id);
  }
  report.logging = {
    records,
    response_ids: [...found].sort(),
    files,
    normal_stop_records: stops,
    jobs: report.jobs.map((job) => ({
      id: job.id,
      start: starts.get(job.id),
      end: ends.get(job.id),
    })),
  };
}

export async function frontendSources(root) {
  const sources = [
    'frontend/src/shared/api/client.ts',
    'frontend/src/shared/jobs/index.ts',
    'frontend/src/features/frida/index.ts',
  ];
  const manifests = await Promise.all(sources.map((path) => inputManifest(join(root, path), [])));
  return [...new Set(manifests.flat().map((entry) => entry.path))].sort();
}
