import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost } from './nested-device-artifacts/host.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const arguments_ = process.argv.slice(2);
assert.ok(
  arguments_.every((value) => value === '--release'),
  '仅支持 --release 参数',
);
const profile = arguments_.includes('--release') ? 'release' : 'debug';
const binary = resolve(
  root,
  'backend',
  'target',
  profile,
  `apk-server${process.platform === 'win32' ? '.exe' : ''}`,
);
await mkdir(join(root, 'artifacts'), { recursive: true });
const directory = await mkdtemp(join(root, 'artifacts', `jpeg-artifact-smoke-${profile}-`));
const report = {
  started_at: new Date().toISOString(),
  profile,
  passed: false,
  checks: [],
  scope:
    '当前真实Rust宿主通用JPEG上传、HTTP原字节下载、MCP元数据与共享历史；最小结构帧不证明像素解码、Harmony截图、视觉或真机',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputPaths = [
  binary,
  fileURLToPath(import.meta.url),
  resolve(root, 'scripts/nested-device-artifacts/host.mjs'),
  resolve(root, 'scripts/nested-device-artifacts/client.mjs'),
  resolve(root, 'scripts/nested-device-artifacts/fixtures.mjs'),
  resolve(root, 'scripts/device-provider/client.mjs'),
  resolve(root, 'backend/scripts/online-plugins/fixtures.mjs'),
];
const identities = async () =>
  Promise.all(
    inputPaths.map(async (path) => {
      const bytes = await readFile(path);
      return { path, bytes: bytes.length, sha256: hash(bytes) };
    }),
  );
let host;

async function verifyDownload(metadata, expected, version) {
  const response = await fetch(
    `${host.client.base}/api/${version}/artifacts/${metadata.id}/content`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert.equal(response.status, 200);
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.match(logId, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  host.client.logIds.add(logId);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(Number(response.headers.get('content-length')), expected.length);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-disposition').startsWith('attachment;'));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, expected);
  assert.equal(hash(bytes), metadata.sha256);
  report.downloads.push({
    version,
    artifact_id: metadata.id,
    log_id: logId,
    bytes: bytes.length,
    sha256: hash(bytes),
  });
}

try {
  report.inputs_before = await identities();
  host = await prepareHost(root, profile, report);
  await host.start();
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63,
    0, 1, 0xff, 0, 2, 0xff, 0xd9,
  ]);
  report.downloads = [];
  report.metadata = [];
  report.jobs = [];
  for (const filename of ['screenshot.jpeg', 'screenshot.JPG']) {
    const metadata = await host.client.json(`/api/v2/artifacts?filename=${filename}`, {
      method: 'POST',
      status: 201,
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    assert.equal(metadata.media_type, 'image/jpeg');
    assert.equal(metadata.filename, filename);
    assert.equal(metadata.size, bytes.length);
    assert.equal(metadata.sha256, hash(bytes));
    report.metadata.push(metadata);
    for (const version of ['v1', 'v2']) await verifyDownload(metadata, bytes, version);
    const submitted = await host.client.tool('artifact.inspect', { artifact_id: metadata.id });
    const job = await host.client.finished(submitted.id);
    assert.deepEqual(job.result, metadata);
    report.jobs.push(job.id);
  }
  report.checks.push({
    name: '两类后缀、媒体类型、大小摘要、两版本原字节下载及MCP共享任务',
    passed: true,
  });
  for (const invalid of [
    bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, Buffer.from([0])]),
    Buffer.from('not-jpeg'),
  ]) {
    await host.client.json('/api/v2/artifacts?filename=invalid.jpeg', {
      method: 'POST',
      status: 400,
      code: 'invalid_input',
      headers: { 'content-type': 'application/octet-stream' },
      body: invalid,
    });
  }
  report.checks.push({ name: '截断、尾随和伪格式精确400 invalid_input', passed: true });
  await host.shutdown();
  await host.verifyLogs();
  await writeFile(
    join(directory, 'logs.jsonl'),
    `${(await host.logs()).map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  report.inputs_after = await identities();
  assert.deepEqual(report.inputs_after, report.inputs_before);
  report.inputs_stable = true;
  report.checks.push({ name: '正常宿主exit0、日志关联及七个输入字节稳定', passed: true });
  report.passed = true;
} catch (error) {
  report.error = String(error.message).split('\n')[0].slice(0, 500);
  process.exitCode = 1;
} finally {
  try {
    if (host) await host.finish([]);
  } catch (error) {
    report.passed = false;
    report.cleanup_error = String(error.message).split('\n')[0].slice(0, 500);
    process.exitCode = 1;
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify({
      passed: report.passed,
      report: join(directory, 'report.json'),
      error: report.error,
    }),
  );
}
