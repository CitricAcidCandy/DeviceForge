import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { sha256 } from '../android-packages-smoke/samples.mjs';
import { video } from './contracts.mjs';

export { failure } from '../apks-advanced-smoke/evidence.mjs';

export async function download(context, output, frontend) {
  const response = await frontend.downloadRecording(output, AbortSignal.timeout(10000));
  const bytes = Buffer.from(await response.data.arrayBuffer());
  assert.deepEqual(bytes, video);
  const artifact = output.artifacts[0];
  assert.equal(output.artifacts.length, 1);
  assert.equal(artifact.filename, 'screen.mp4');
  assert.equal(artifact.media_type, 'video/mp4');
  assert.equal(artifact.size, bytes.length);
  assert.equal(artifact.sha256, sha256(bytes));
  const metadata = await context.host.client.json('/api/v2/artifacts/' + artifact.id);
  assert.deepEqual(metadata, artifact);
  context.report.downloads.push({ artifact_id: artifact.id, log_id: response.logId, bytes: bytes.length, sha256: sha256(bytes), exact_original_bytes: true });
}

function values(record, key) {
  const found = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      if (name === key && typeof item === 'string') found.add(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(record.fields); visit(record.span); visit(record.spans); return found;
}

export async function logs(context) {
  const responseIds = new Set(), starts = new Map(), ends = new Map(), files = [];
  let records = 0, bytes = 0, stops = 0;
  const root = join(context.directory, 'data/logs');
  for (const name of (await readdir(root)).filter(value => value.endsWith('.jsonl'))) {
    const path = join(root, name), identity = await fileIdentity(path);
    files.push(identity); bytes += identity.bytes;
    assert.ok(identity.bytes <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes('synthetic recording complete'));
    for (const [offset, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      const record = JSON.parse(line), ids = values(record, 'log_id'); records++;
      for (const id of ids) if (context.host.client.logIds.has(id)) responseIds.add(id);
      const message = record.fields?.message;
      if (message === '宿主运行已结束') stops++;
      if (!values(record, 'plugin_id').has('mirroring')) continue;
      const job = context.report.jobs.find(value => values(record, 'job_id').has(value.job_id));
      if (!job) continue;
      const collection = message === '插件调用开始' ? starts : message === '插件调用结束' ? ends : undefined;
      if (!collection) continue;
      assert.ok(!collection.has(job.job_id));
      const requestIds = [...values(record, 'plugin_request_id')];
      assert.equal(requestIds.length, 1); assert.match(requestIds[0], /^[a-f\d-]{36}$/);
      assert.ok(ids.has(job.submit_log_id));
      if (collection === ends) assert.equal(record.fields.code, job.expected_status === 'succeeded' ? 'ok' : job.expected_status === 'cancelled' ? 'cancelled' : 'dependency_failed');
      collection.set(job.job_id, { path, line: offset + 1, request_id: requestIds[0], code: record.fields.code });
    }
  }
  assert.deepEqual([...responseIds].sort(), [...context.host.client.logIds].sort());
  assert.equal(starts.size, context.report.jobs.length); assert.equal(ends.size, context.report.jobs.length); assert.ok(stops > 0);
  const requestIds = new Set();
  for (const job of context.report.jobs) {
    assert.equal(starts.get(job.job_id).request_id, ends.get(job.job_id).request_id);
    assert.ok(!requestIds.has(starts.get(job.job_id).request_id)); requestIds.add(starts.get(job.job_id).request_id);
  }
  context.report.logging = { records, response_ids: [...responseIds].sort(), files, normal_stop_records: stops,
    jobs: context.report.jobs.map(job => ({ job_id: job.job_id, start: starts.get(job.job_id), end: ends.get(job.job_id) })) };
}
