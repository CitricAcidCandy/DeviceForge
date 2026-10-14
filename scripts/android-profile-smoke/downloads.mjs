import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export async function download(host, directory, report, artifact, caseId) {
  assert.match(caseId, /^[a-z][a-z0-9-]{0,63}$/, 'PROFILE-DOWNLOAD-CASE');
  assert.deepEqual(
    Object.keys(artifact).sort(),
    ['created_at', 'filename', 'id', 'media_type', 'sha256', 'size'],
    'PROFILE-ARTIFACT-METADATA',
  );
  assert.match(artifact.id, uuid);
  assert.match(artifact.sha256, /^[a-f\d]{64}$/);
  assert.ok(
    ['profile-index.json', 'profile.zip'].includes(artifact.filename),
    'PROFILE-ARTIFACT-NAME',
  );
  assert.ok(
    Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= 64 * 1024 * 1024,
    'PROFILE-ARTIFACT-BOUND',
  );
  assert.equal(
    artifact.media_type,
    artifact.filename.endsWith('.zip') ? 'application/zip' : 'application/json',
    'PROFILE-ARTIFACT-MEDIA',
  );
  assert.deepEqual(
    await host.client.json('/api/v2/artifacts/' + artifact.id),
    artifact,
    'PROFILE-ARTIFACT-DETAIL',
  );
  const path = '/api/v2/artifacts/' + artifact.id + '/content';
  const response = await fetch(host.client.base + path, { signal: AbortSignal.timeout(10000) });
  const logId = response.headers.get('x-deviceforge-log-id');
  report.requests.push({
    case_id: caseId,
    phase: 'download',
    method: 'GET',
    path,
    status: response.status,
    log_id: logId,
  });
  assert.equal(response.status, 200);
  assert.match(logId, uuid);
  host.client.logIds.add(logId);
  const destination = join(directory, caseId + '-' + artifact.filename);
  const handle = await open(destination, 'wx'),
    reader = response.body.getReader();
  const chunks = [],
    digest = createHash('sha256');
  let count = 0,
    complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        break;
      }
      const chunk = Buffer.from(item.value);
      count += chunk.length;
      assert.ok(count <= artifact.size, 'PROFILE-DOWNLOAD-SIZE-LIMIT');
      digest.update(chunk);
      chunks.push(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(
          chunk.subarray(offset, Math.min(offset + 4096, chunk.length)),
        );
        assert.ok(result.bytesWritten > 0, 'PROFILE-DOWNLOAD-WRITE-PROGRESS');
        offset += result.bytesWritten;
      }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
    await handle.close();
  }
  assert.equal(count, artifact.size, 'PROFILE-DOWNLOAD-SIZE');
  const sha256 = digest.digest('hex');
  assert.equal(sha256, artifact.sha256, 'PROFILE-DOWNLOAD-SHA');
  const identity = await fileIdentity(destination);
  assert.equal(identity.sha256, sha256);
  assert.equal(identity.bytes, count);
  report.downloads ??= [];
  report.downloads.push({
    case_id: caseId,
    artifact: structuredClone(artifact),
    log_id: logId,
    actual: identity,
  });
  return Buffer.concat(chunks, count);
}
