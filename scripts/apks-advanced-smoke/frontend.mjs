import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  advancedPrivate,
  advancedSpec,
  apkEntries,
  apks,
  extractOperation,
  serial,
} from './contracts.mjs';
import { callKeys, finished, release, started } from './fixtures.mjs';
import { record } from './jobs.mjs';
import { download } from './artifacts.mjs';
import { installation } from './cases.mjs';

export async function frontend(context) {
  const { createApiClient } = await import(
    pathToFileURL(join(context.root, 'frontend/src/shared/api/index.ts')).href
  );
  const { createHttpJobGateway } = await import(
    pathToFileURL(join(context.root, 'frontend/src/shared/jobs/index.ts')).href
  );
  const { createPackageAnalysis, prepareApksInstallInput } = await import(
    pathToFileURL(join(context.root, 'frontend/src/features/package-analysis/index.ts')).href
  );
  const requests = [];
  let entry;
  const transport = async (input, options) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const response = await fetch(input, options),
      logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, /^[a-f\d-]{36}$/);
    context.host.client.logIds.add(logId);
    const request = {
      client_method: 'frontend-factory',
      path: url.pathname + url.search,
      method: options?.method ?? 'GET',
      status: response.status,
      log_id: logId,
      outcome: 'returned',
    };
    context.report.requests.push(request);
    requests.push(request);
    if (url.pathname === '/api/v2/jobs' && options?.method === 'POST') {
      assert.equal(entry, undefined, '真实前端仅提交一次提取任务');
      const body = JSON.parse(options.body),
        { data } = await response.clone().json();
      assert.equal(body.operation, extractOperation);
      assert.deepEqual(body.input, {
        artifact_id: context.source.id,
        device_spec: advancedSpec,
        modules: ['base', 'feature_1'],
        instant: true,
      });
      entry = {
        case_id: '前端高级extractSplits真实消费',
        operation: body.operation,
        input: body.input,
        job_id: data.id,
        expected_status: 'succeeded',
        plugin_id: 'android-packages',
        submit_log_id: logId,
        transport: 'frontend-http',
      };
      context.report.jobs.push(entry);
    }
    return response;
  };
  const client = createApiClient({ baseUrl: context.host.client.base, transport });
  const packages = createPackageAnalysis(
    createHttpJobGateway(client),
    { pollIntervalMs: 10 },
    { download: client.downloadArtifact },
  );
  const signal = AbortSignal.timeout(30000);
  try {
    const original = {
      artifact_id: context.source.id.toUpperCase(),
      device_spec: advancedSpec,
      modules: ['base', 'feature_1'],
      instant: true,
    };
    const previous = await callKeys(context.tool);
    const promise = packages.extractSplits(original, signal);
    promise.catch(() => {});
    const call = await started(context, previous, {
      pluginId: 'android-packages',
      command: 'extract-apks',
      inputBytes: apks,
      privateBytes: advancedPrivate,
      modules: ['base', 'feature_1'],
      instant: true,
    });
    await release(call);
    const outcome = await promise;
    assert.deepEqual(outcome.data.result, { device_spec: advancedSpec, apk_entries: apkEntries });
    assert.equal(Object.hasOwn(outcome.data.result, 'modules'), false);
    assert.equal(Object.hasOwn(outcome.data.result, 'instant'), false);
    const job = await record(context, entry);
    assert.deepEqual(job.result, outcome.data);
    await finished(context, call);
    const nativeBytes = await download(context, outcome.data.artifacts[0]);
    const published = await packages.downloadSplits(outcome.data, signal);
    assert.deepEqual(Buffer.from(await published.data.arrayBuffer()), nativeBytes);
    const ticket = {
      id: entry.job_id,
      operation: extractOperation,
      submitLogId: outcome.submitLogId,
    };
    const restored = await packages.resumeExtractSplits(ticket, original, signal);
    assert.deepEqual(restored.data, outcome.data);
    assert.equal(
      requests.filter((value) => value.path === '/api/v2/jobs' && value.method === 'POST').length,
      1,
    );
    const prepared = prepareApksInstallInput({
      artifact_id: context.source.id.toUpperCase(),
      modules: ['base', 'feature_1'],
    });
    assert.deepEqual(prepared, { artifact_id: context.source.id, modules: ['base', 'feature_1'] });
    assert.ok(Object.isFrozen(prepared.modules));
    await installation(context, {
      caseId: '前端安装助手嵌套modules真实设备动作',
      modules: ['base', 'feature_1'],
      capability: true,
      prepared,
    });
    context.report.frontend = {
      factory: 'createPackageAnalysis',
      advanced_extract_job_id: entry.job_id,
      requests,
      request_count: requests.length,
      one_submit_without_replay: true,
      resumed_same_result: true,
      actual_download_bytes_equal: true,
      prepared_install_input: prepared,
      device_id: serial,
    };
    context.report.checks.push({
      name: '真实前端高级提取/下载/历史恢复及安装输入助手',
      passed: true,
    });
  } finally {
    packages.dispose();
  }
}
