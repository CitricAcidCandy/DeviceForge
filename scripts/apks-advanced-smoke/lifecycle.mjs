import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  apks,
  advancedPrivate,
  advancedSpec,
  extractOperation,
  installOperation,
  serial,
} from './contracts.mjs';
import { callKeys, emptyScratch, finished, started } from './fixtures.mjs';
import { history, record, submit } from './jobs.mjs';
import { download } from './artifacts.mjs';
import { extraction } from './cases.mjs';

export async function visibility(context, present) {
  const operations = await context.host.client.json('/api/v2/operations');
  assert.deepEqual(await context.host.client.tool('deviceforge.list_operations', {}), operations);
  const tools = new Set(await context.host.client.tools());
  for (const id of [
    extractOperation,
    installOperation,
    'android.package.extract_splits',
    'android.app.install_apks',
  ]) {
    assert.equal(
      operations.some((value) => value.id === id),
      present,
    );
    assert.equal(tools.has(id), present);
  }
  if (present) {
    assert.deepEqual(operations.find((value) => value.id === extractOperation).execution, {
      api_version: 1,
      total_timeout_ms: 120000,
      source: 'declared',
    });
    assert.equal(
      Object.hasOwn(
        operations.find((value) => value.id === installOperation),
        'execution',
      ),
      false,
    );
  }
}

export async function lifecycle(context) {
  let previous = await callKeys(context.tool);
  const installation = await submit(context, {
    caseId: '高级安装在途取消',
    operation: installOperation,
    input: {
      device_id: serial,
      input: { artifact_id: context.source.id, modules: ['base', 'feature_1'] },
    },
    expectedStatus: 'cancelled',
  });
  let call = await started(context, previous, {
    pluginId: 'android-device',
    command: 'install-apks',
    inputBytes: apks,
    modules: ['base', 'feature_1'],
    deviceId: serial,
  });
  await context.host.client.post('/api/v2/jobs/' + installation.job_id + '/cancel');
  const cancelled = await record(context, installation);
  assert.equal(cancelled.result, null);
  await finished(context, call, { cancelled: true });
  context.report.checks.push({
    name: '高级安装在途取消、实际直接父子退出与私有目录清理',
    passed: true,
  });

  previous = await callKeys(context.tool);
  const extractionJob = await submit(context, {
    caseId: '高级提取在途卸载',
    operation: extractOperation,
    input: {
      artifact_id: context.source.id,
      device_spec: advancedSpec,
      modules: ['base', 'feature_1'],
      instant: true,
    },
    expectedStatus: 'cancelled',
  });
  call = await started(context, previous, {
    pluginId: 'android-packages',
    command: 'extract-apks',
    inputBytes: apks,
    privateBytes: advancedPrivate,
    modules: ['base', 'feature_1'],
    instant: true,
  });
  const unloaded = await context.host.client.tool('deviceforge.unload_plugin', {
    id: 'android-packages',
  });
  assert.equal(unloaded.state, 'unloaded');
  assert.equal(unloaded.cleanup_failed, false);
  assert.equal((await record(context, extractionJob)).result, null);
  await finished(context, call, { cancelled: true });
  const device = await context.host.client.post('/api/v2/plugins/android-device/unload');
  assert.equal(device.state, 'unloaded');
  assert.equal(device.cleanup_failed, false);
  await visibility(context, false);
  await history(context, '双插件卸载后');
  for (const deployment of context.deployments) {
    deployment.retired = join(context.directory, deployment.id + '-retired');
    await rename(deployment.published, deployment.retired);
  }
  await visibility(context, false);
  await history(context, '双部署目录撤离后');
  for (const entry of context.report.jobs.filter((value) => value.artifact))
    await download(context, entry.artifact);
  context.report.checks.push({
    name: '在途高级提取卸载、贡献撤销、双部署撤离后Job/事件/产物原字节保留',
    passed: true,
  });
  for (const deployment of context.deployments) {
    await rename(deployment.retired, deployment.published);
    const loaded = await context.host.client.post('/api/v2/plugins/' + deployment.id + '/load');
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    assert.notEqual(loaded.generation, deployment.generation);
    context.report.deployment.plugins.find(
      (value) => value.id === deployment.id,
    ).reloaded_generation = loaded.generation;
  }
  await visibility(context, true);
  await history(context, '双插件新代次后');
  await extraction(context, { caseId: '重载新代次基本提取' });
  await emptyScratch(context);
  context.report.checks.push({ name: '双插件新代次重载及原Job不重提恢复', passed: true });
}
