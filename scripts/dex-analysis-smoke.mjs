import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '../frontend/src/shared/api/client.ts';
import { createHttpDexAnalysis } from '../frontend/src/features/dex-analysis/index.ts';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { poll } from './terminal-interactive-smoke/cases.mjs';
import { dexFixture } from './dex-analysis-smoke/fixture.mjs';
import { verifyLogs } from './dex-analysis-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.slice(2).every((argument) => argument === '--release'));
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const directory = join(root, 'artifacts', `dex-analysis-service-${profile}-${randomUUID()}`);
const snapshot = join(directory, 'snapshot');
const suffix = process.platform === 'win32' ? '.exe' : '';
const report = {
  timestamp: new Date().toISOString(),
  profile,
  passed: false,
  checks: [],
  requests: [],
  jobs: [],
  scope:
    '真实宿主与独立DEX插件、前端公开基础用例的真实HTTP、MCP和原字节；结构夹具不代表真实APK或真机',
};
await mkdir(snapshot, { recursive: true });
let host, analysis;

async function upload(bytes, filename) {
  return host.client.json(`/api/v2/artifacts?filename=${filename}`, {
    method: 'POST',
    status: 201,
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
}

async function recorded(submitted, submitLogId, status = 'succeeded') {
  const info = await poll(
    () => host.client.job(submitted.id),
    (info) => ['succeeded', 'failed', 'cancelled'].includes(info.status),
    'DEX任务终态',
  );
  assert.equal(info.status, status);
  assert.deepEqual(await host.client.tool('deviceforge.get_job', { id: info.id }), info);
  assert.ok(!report.jobs.some((job) => job.id === info.id));
  report.jobs.push({ id: info.id, operation: info.operation, status, submit_log_id: submitLogId });
  return info;
}

async function download(metadata, expected, version) {
  const response = await fetch(
    `${host.client.base}/api/${version}/artifacts/${metadata.id}/content`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert.equal(response.status, 200);
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.match(logId, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  host.client.logIds.add(logId);
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.dex');
  assert.equal(Number(response.headers.get('content-length')), expected.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  report.requests.push({
    path: `/api/${version}/artifacts/${metadata.id}/content`,
    status: 200,
    log_id: logId,
  });
}

async function frontendSources() {
  const directories = [
    'frontend/src/shared/api',
    'frontend/src/shared/jobs',
    'frontend/src/features/dex-analysis',
  ];
  const members = await Promise.all(
    directories.map(async (directory) => {
      const entries = await readdir(join(root, directory), {
        recursive: true,
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => join(entry.parentPath, entry.name));
    }),
  );
  return members.flat().sort();
}

try {
  const sources = [
    join(root, 'backend/target', profile, 'apk-server' + suffix),
    join(root, 'backend/target', profile, 'deviceforge-dex-analysis-plugin' + suffix),
    join(root, 'backend/plugins/dex-analysis/manifest.json'),
    fileURLToPath(import.meta.url),
    join(root, 'scripts/dex-analysis-smoke/fixture.mjs'),
    join(root, 'scripts/dex-analysis-smoke/evidence.mjs'),
  ];
  const names = [
    'apk-server' + suffix,
    'deviceforge-dex-analysis-plugin' + suffix,
    'manifest.json',
    'dex-analysis-smoke.mjs',
    'fixture.mjs',
    'evidence.mjs',
  ];
  report.inputs_before = await Promise.all(sources.map(fileIdentity));
  const frontendPaths = await frontendSources();
  report.frontend_before = await Promise.all(frontendPaths.map(fileIdentity));
  for (const [index, source] of sources.entries()) {
    await copyFile(source, join(snapshot, names[index]));
    assert.equal(
      (await fileIdentity(join(snapshot, names[index]))).sha256,
      report.inputs_before[index].sha256,
    );
  }
  host = await prepareHost({
    root,
    binary: join(snapshot, names[0]),
    directory: join(directory, 'data'),
    report,
    port: await reservePort(),
  });
  await host.ready();
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json')));
  manifest.executable = join(snapshot, names[1]);
  const deployed = join(host.plugins, 'dex-analysis');
  await mkdir(deployed);
  await writeFile(join(deployed, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  const loaded = await host.client.post('/api/v2/plugins/dex-analysis/load');
  assert.equal(loaded.operations.length, 2);
  assert.ok((await host.client.tools()).includes('plugin.dex-analysis.inspect'));
  report.checks.push({ name: '独立DEX插件动态加载和MCP目录', passed: true });
  const bytes = dexFixture();
  const metadata = await upload(bytes, 'classes.DEX');
  assert.equal(metadata.media_type, 'application/vnd.android.dex');
  assert.equal(metadata.filename, 'classes.DEX');
  assert.equal(metadata.size, bytes.length);
  assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
  report.artifacts = [metadata];
  for (const version of ['v1', 'v2']) await download(metadata, bytes, version);
  report.checks.push({ name: '真实HTTP上传、大小写后缀与两版本DEX原字节', passed: true });

  const client = createApiClient({
    baseUrl: host.client.base,
    transport: async (input, options) => {
      const response = await fetch(input, options);
      const logId = response.headers.get('x-deviceforge-log-id');
      assert.match(logId, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
      host.client.logIds.add(logId);
      report.requests.push({
        client_method: 'frontend',
        path: new URL(input).pathname,
        method: options?.method,
        status: response.status,
        log_id: logId,
      });
      return response;
    },
  });
  analysis = createHttpDexAnalysis(client, { pollIntervalMs: 20 });
  const signal = AbortSignal.timeout(30000);
  const definitions = await analysis.refreshOperations(signal);
  assert.deepEqual(definitions.data.map((operation) => operation.id).sort(), [
    'plugin.dex-analysis.inspect',
    'plugin.dex-analysis.scan_sdks',
  ]);
  const artifactInput = { artifact_id: metadata.id };
  const expected = {
    ...artifactInput,
    version: '039',
    file_size: bytes.length,
    counts: { strings: 2, types: 2, prototypes: 0, fields: 0, methods: 0, defined_classes: 1 },
    integrity: { artifact_sha256: true, dex_sha1: true, dex_adler32: true },
  };
  const inspected = await analysis.inspect(artifactInput, signal);
  assert.deepEqual(inspected.data, expected);
  await recorded(inspected.job, inspected.submitLogId);
  const rules = [
    { name: '定义类', package_path: 'com.example.sdk', class_name: 'Entry$Inner' },
    { name: '外部引用', package_path: 'com.reference.sdk', class_name: 'Entry' },
  ];
  const scanInput = { ...artifactInput, rules };
  const expectedScan = {
    ...expected,
    findings: [
      {
        rule: rules[0],
        package_found: true,
        class_found: true,
        evidence: ['com/example/sdk/Entry$Inner'],
      },
      { rule: rules[1], package_found: false, class_found: false, evidence: [] },
    ],
  };
  const scanned = await analysis.scanSdks(scanInput, signal);
  assert.deepEqual(scanned.data, expectedScan);
  await recorded(scanned.job, scanned.submitLogId);
  report.checks.push({
    name: '真实前端公开用例消费inspect与scan，仅定义类作为SDK证据',
    passed: true,
  });

  const mcpInspection = await host.client.tool('plugin.dex-analysis.inspect', artifactInput);
  const mcpInspectLogId = report.last_request.log_id;
  const inspectJob = await recorded(mcpInspection, mcpInspectLogId);
  assert.deepEqual(inspectJob.result, { result: expected, artifacts: [] });
  const mcpScan = await host.client.tool('plugin.dex-analysis.scan_sdks', scanInput);
  const mcpScanLogId = report.last_request.log_id;
  const scanJob = await recorded(mcpScan, mcpScanLogId);
  assert.deepEqual(scanJob.result, { result: expectedScan, artifacts: [] });
  report.checks.push({ name: 'MCP实际提交两贡献且HTTP/MCP读取同一Job', passed: true });
  const damaged = Buffer.from(bytes);
  damaged[8] ^= 1;
  const damagedMetadata = await upload(damaged, 'bad-checksum.dex');
  report.artifacts.push(damagedMetadata);
  const submitted = await host.client.post(
    '/api/v2/jobs',
    {
      operation: 'plugin.dex-analysis.inspect',
      input: { artifact_id: damagedMetadata.id },
    },
    { status: 202 },
  );
  const failed = await recorded(submitted, report.last_request.log_id, 'failed');
  assert.equal(failed.result, null);
  assert.ok(typeof failed.error === 'string' && failed.error.length > 0);
  await download(damagedMetadata, damaged, 'v2');
  report.checks.push({
    name: '最低上传资格与完整校验分离，错误checksum失败且保留原字节',
    passed: true,
  });

  const unloaded = await host.client.post('/api/v2/plugins/dex-analysis/unload');
  assert.equal(unloaded.state, 'unloaded');
  assert.ok(!(await host.client.tools()).some((name) => name.startsWith('plugin.dex-analysis.')));
  assert.deepEqual((await analysis.refreshOperations(signal)).data, []);
  assert.throws(
    () => analysis.inspect(artifactInput, signal),
    (error) => error.code === 'dex_operation_unavailable',
  );
  const beforeResume = (await host.client.json('/api/v2/jobs?limit=100')).length;
  const resumedInspect = await analysis.resumeInspect(
    { id: mcpInspection.id, operation: mcpInspection.operation, submitLogId: mcpInspectLogId },
    artifactInput,
    signal,
  );
  const resumedScan = await analysis.resumeScanSdks(
    { id: mcpScan.id, operation: mcpScan.operation, submitLogId: mcpScanLogId },
    scanInput,
    signal,
  );
  assert.deepEqual(resumedInspect.data, expected);
  assert.deepEqual(resumedScan.data, expectedScan);
  assert.equal(resumedInspect.submitLogId, mcpInspectLogId);
  assert.equal(resumedScan.submitLogId, mcpScanLogId);
  assert.equal((await host.client.json('/api/v2/jobs?limit=100')).length, beforeResume);
  report.checks.push({ name: '卸载动态撤销，新提交拒绝且前端恢复原MCP历史不重发', passed: true });

  await host.shutdown();
  await host.verifyIdentity();
  report.inputs_after = await Promise.all(sources.map(fileIdentity));
  assert.deepEqual(report.inputs_after, report.inputs_before);
  report.frontend_after = await Promise.all(frontendPaths.map(fileIdentity));
  assert.deepEqual(report.frontend_after, report.frontend_before);
  await verifyLogs(directory, host, report);
  report.checks.push({
    name: '真实宿主exit0、监听释放、全部响应和Job日志及运行前后身份',
    passed: true,
  });
  report.passed = true;
} catch (error) {
  report.failure = {
    name: error.name,
    code: error.code,
    message: error.message,
    locations: String(error.stack)
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 6),
  };
} finally {
  analysis?.dispose();
  if (host) {
    try {
      await host.finish();
    } catch (error) {
      report.passed = false;
      report.cleanup_failure = { name: error.name, code: error.code };
    }
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      directory,
      passed: report.passed,
      checks: report.checks.length,
      jobs: report.jobs.length,
      failure: report.failure,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
