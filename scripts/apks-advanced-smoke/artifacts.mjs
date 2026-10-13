import assert from 'node:assert/strict';
import { sha256, baseApk, featureApk, apkEntries } from './contracts.mjs';
import { entries } from './zip.mjs';

export async function upload(context, filename, bytes) {
  const value = await context.host.client.json('/api/v2/artifacts?filename=' + encodeURIComponent(filename),
    { method: 'POST', status: 201, headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  assert.equal(value.filename, filename);
  assert.equal(value.size, bytes.length);
  assert.equal(value.sha256, sha256(bytes));
  context.report.artifacts.push({ metadata: value, original_bytes: bytes.length, sha256: sha256(bytes) });
  return value;
}

export async function download(context, artifact) {
  assert.deepEqual(await context.host.client.json('/api/v2/artifacts/' + artifact.id), artifact);
  const path = `/api/v2/artifacts/${artifact.id}/content`;
  const response = await fetch(context.host.client.base + path, { signal: AbortSignal.timeout(5000) });
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.equal(response.status, 200);
  assert.match(logId, /^[a-f\d-]{36}$/);
  context.host.client.logIds.add(logId);
  context.report.requests.push({ client_method: 'download', path, method: 'GET', status: 200, log_id: logId, outcome: 'returned' });
  const reader = response.body.getReader(), chunks = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      size += chunk.value.length;
      assert.ok(size <= 65536);
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  assert.equal(artifact.size, bytes.length);
  assert.equal(artifact.sha256, sha256(bytes));
  assert.equal(artifact.filename, 'selected-apks.zip');
  const unpacked = entries(bytes);
  assert.deepEqual([...unpacked.keys()], apkEntries);
  assert.deepEqual(unpacked.get(apkEntries[0]), baseApk);
  assert.deepEqual(unpacked.get(apkEntries[1]), featureApk);
  context.report.downloads.push({ artifact_id: artifact.id, log_id: logId, size, sha256: sha256(bytes),
    apk_entries: apkEntries, actual_apk_bytes_equal: true });
  return bytes;
}
