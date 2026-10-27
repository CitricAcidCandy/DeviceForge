import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { markers, poll, processProof, save, waitNewMarker } from './common.mjs';
import { installExample } from './packages.mjs';

const normalize = 'example.text.normalize';
const compose = 'example.text.compose';
const normalizePlugin = 'service-normalize';
const composePlugin = 'service-compose';
const composeOperation = `plugin.${composePlugin}.compose`;
const pingOperation = `plugin.${composePlugin}.ping`;
const text = { text: '  HeLLo  ' };

function succeeded(job, expected) {
  assert.equal(job.status, 'succeeded', job.error ?? '任务未成功');
  assert.deepEqual(job.result, { result: expected, artifacts: [] }, '顶层必须保留既有产物封套');
}

export async function runMatrix(context) {
  const { api, report, directories } = context;
  async function scenario(name, execute) {
    const record = { name, passed: false, started_at: new Date().toISOString() };
    report.scenarios.push(record);
    try { await execute(record); record.passed = true; }
    finally { record.completed_at = new Date().toISOString(); }
  }
  async function ping() {
    for (const transport of ['http', 'mcp']) {
      succeeded(await api.finished((await api.operation(pingOperation, {}, transport)).id), { alive: true });
    }
    assert.ok((await api.get('/api/v2/plugins')).some((plugin) => plugin.id === composePlugin && plugin.state === 'loaded'));
  }
  async function dependencyBlocked() {
    const services = await api.catalog();
    const consumer = services.find((item) => item.service.id === compose);
    assert.equal(consumer.available, false);
    assert.ok(consumer.unavailable_reason?.length > 0);
    await api.rejectService(compose, text, 409, 'conflict');
    await api.rejectOperation(composeOperation, text, 409, 'conflict');
    await ping();
  }
  async function composeSuccess(transport = 'http') {
    const task = await api.service(compose, text, transport);
    const job = await api.finished(task.id);
    succeeded(job, { text: 'FORGE: hello' });
    assert.equal(job.operation, composeOperation);
    assert.ok((await api.get('/api/v2/plugins')).every((plugin) => !plugin.cleanup_failed),
      '正常示例业务失败或取消不应产生伪清理失败');
    return job;
  }
  const beforeMarkers = async (kind) => new Set((await markers(directories[kind])).map((item) => item.request_id));
  async function holdCall(transport) {
    const previous = { compose: await beforeMarkers('compose'), normalize: await beforeMarkers('normalize') };
    await writeFile(join(directories.normalize, 'hold'), '本轮受控等待屏障\n', 'utf8');
    const task = await api.service(compose, text, transport);
    const parent = await waitNewMarker(directories.compose, previous.compose, '组合插件启动');
    const child = await waitNewMarker(directories.normalize, previous.normalize, '规范化子调用启动');
    assert.notEqual(parent.pid, child.pid, '必须是两个真实独立 Rust 进程');
    assert.notEqual(parent.pid, report.host.pid);
    assert.notEqual(child.pid, report.host.pid);
    await poll(() => api.job(task.id), (job) => job.status === 'running', '根 Job 运行中');
    return { task, parent, child };
  }
  async function releaseHold() {
    try { await unlink(join(directories.normalize, 'hold')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  let provider;
  let consumer;
  let firstGeneration;
  await scenario('空插件启动与仅消费者依赖隔离', async (record) => {
    assert.deepEqual(await api.get('/api/v2/plugins'), []);
    assert.deepEqual(await api.catalog(), []);
    consumer = await installExample(context, 'compose');
    record.consumer = await api.manage(composePlugin, 'load', 'mcp');
    await dependencyBlocked();
  });
  await scenario('独立原生安装与HTTP/MCP组合共享Job', async (record) => {
    provider = await installExample(context, 'normalize');
    const loaded = await api.manage(normalizePlugin, 'load');
    firstGeneration = loaded.generation;
    const catalog = await api.catalog();
    assert.equal(catalog.length, 2);
    assert.ok(catalog.every((service) => service.available && service.unavailable_reason === null));
    assert.equal(catalog.find((item) => item.service.id === normalize).provider.generation, firstGeneration);
    record.catalog = catalog;
    for (const transport of ['http', 'mcp']) {
      await composeSuccess(transport);
      succeeded(await api.finished((await api.service(normalize, text, transport)).id), { text: 'hello' });
      succeeded(await api.finished((await api.operation(composeOperation, text, transport)).id), { text: 'FORGE: hello' });
    }
  });
  await scenario('精确字符串版本与顶层输入模式拒绝且零Job', async () => {
    for (const version of ['1', '1.0.0', ' 1.0 ']) {
      await api.rejectService(normalize, text, 404, 'not_found', { version });
    }
    for (const version of [1, '', ' ', null]) {
      await api.rejectService(normalize, text, 400, 'invalid_input', { version });
    }
    for (const invalid of [{ text: 42 }, {}, { text: 'ok', extra: true }]) {
      await api.rejectService(normalize, invalid, 400, 'invalid_input');
      await api.rejectService(compose, invalid, 400, 'invalid_input');
    }
  });
  await scenario('提供者卸载只阻止相关入口及恢复旧代际拒绝', async (record) => {
    record.unloaded = await api.manage(normalizePlugin, 'unload', 'mcp');
    assert.equal((await api.catalog()).some((item) => item.service.id === normalize), false);
    await api.rejectService(normalize, text, 404, 'not_found');
    await dependencyBlocked();
    record.reloaded = await api.manage(normalizePlugin, 'load');
    assert.notEqual(record.reloaded.generation, firstGeneration);
    await api.rejectService(normalize, text, 409, 'conflict', { generation: firstGeneration });
    succeeded(await api.finished((await api.service(normalize, text, 'mcp', {
      generation: record.reloaded.generation,
    })).id), { text: 'hello' });
    await composeSuccess();
  });
  await scenario('错误提供版本不满足依赖但不封锁提供者及ping', async (record) => {
    const old = await api.manage(normalizePlugin, 'unload');
    const wrong = structuredClone(provider.manifest);
    wrong.services.provided[0].service.version = '1';
    await save(provider.path, wrong);
    record.wrong_version = await api.manage(normalizePlugin, 'load', 'mcp');
    await dependencyBlocked();
    await api.rejectService(normalize, text, 404, 'not_found');
    succeeded(await api.finished((await api.service(normalize, text, 'mcp', { version: '1' })).id), { text: 'hello' });
    await api.manage(normalizePlugin, 'unload');
    await save(provider.path, provider.manifest);
    record.restored = await api.manage(normalizePlugin, 'load');
    await api.rejectService(normalize, text, 409, 'conflict', { generation: old.generation });
    await composeSuccess('mcp');
  });
  await scenario('嵌套输入模式拒绝不启动目标进程且保持共享Job', async () => {
    await api.manage(normalizePlugin, 'unload');
    const strict = structuredClone(provider.manifest);
    strict.operations[0].input_schema.properties.text.maxLength = 3;
    strict.services.provided[0].contract.input_schema = structuredClone(strict.operations[0].input_schema);
    await save(provider.path, strict);
    await api.manage(normalizePlugin, 'load');
    const before = await markers(directories.normalize);
    for (const transport of ['http', 'mcp']) {
      const job = await api.finished((await api.service(compose, text, transport)).id);
      assert.equal(job.status, 'failed');
      assert.match(job.error, /invalid_input/);
    }
    assert.deepEqual(await markers(directories.normalize), before, '子输入未通过模式时不能启动提供者');
    await ping();
    await api.manage(normalizePlugin, 'unload');
    await save(provider.path, provider.manifest);
    await api.manage(normalizePlugin, 'load');
    await composeSuccess();
  });
  await scenario('提供者输出模式拒绝贯通顶层和类型化子调用', async () => {
    await api.manage(normalizePlugin, 'unload');
    const strict = structuredClone(provider.manifest);
    strict.services.provided[0].contract.output_schema.properties.text.type = 'integer';
    await save(provider.path, strict);
    await api.manage(normalizePlugin, 'load');
    for (const transport of ['http', 'mcp']) {
      const direct = await api.finished((await api.service(normalize, text, transport)).id);
      assert.equal(direct.status, 'failed');
      assert.match(direct.error, /服务输出不符合契约/);
      const nested = await api.finished((await api.service(compose, text, transport)).id);
      assert.equal(nested.status, 'failed');
      assert.match(nested.error, /dependency_failed/);
      assert.doesNotMatch(nested.error, /清理未确认/);
    }
    await ping();
    await api.manage(normalizePlugin, 'unload');
    await save(provider.path, provider.manifest);
    await api.manage(normalizePlugin, 'load');
    await composeSuccess('mcp');
  });
  for (const transport of ['http', 'mcp']) {
    await scenario(`父取消传播与父子清理退出-${transport}`, async (record) => {
      const call = await holdCall(transport);
      record.job_id = call.task.id;
      record.started = { parent: call.parent, child: call.child };
      const started = performance.now();
      if (transport === 'http') await api.post(`/api/v2/jobs/${call.task.id}/cancel`);
      else await api.tool('deviceforge.cancel_job', { id: call.task.id });
      const job = await api.finished(call.task.id);
      assert.equal(job.status, 'cancelled', job.error ?? '父取消未保留取消终态');
      record.processes = [await processProof(directories.compose, call.parent, true),
        await processProof(directories.normalize, call.child, true)];
      record.cancel_ms = performance.now() - started;
      await releaseHold();
      await delay(150);
      assert.deepEqual(await api.job(job.id), job, '晚到结果不得覆盖父取消终态');
      await composeSuccess(transport);
      assert.deepEqual(await api.job(job.id), job, '下一笔成功不能覆盖旧取消');
    });
  }
  await scenario('活动子调用提供者卸载与恢复不接受旧代结果', async (record) => {
    const call = await holdCall('mcp');
    record.started = { parent: call.parent, child: call.child };
    record.unloaded = await api.manage(normalizePlugin, 'unload');
    const job = await api.finished(call.task.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /cancelled|conflict/);
    assert.doesNotMatch(job.error, /清理未确认/);
    record.processes = [await processProof(directories.normalize, call.child, true),
      await processProof(directories.compose, call.parent)];
    await releaseHold();
    await dependencyBlocked();
    record.reloaded = await api.manage(normalizePlugin, 'load', 'mcp');
    assert.notEqual(record.reloaded.generation, record.unloaded.generation);
    await api.rejectService(normalize, text, 409, 'conflict', { generation: record.unloaded.generation });
    await composeSuccess();
    assert.deepEqual(await api.job(job.id), job, '恢复不能使旧调用复活或变成功');
  });
  await scenario('子调用不额外创建顶层Job与消费者卸载目录撤销', async (record) => {
    const jobs = await api.get('/api/v2/jobs?limit=200');
    assert.equal(jobs.length, report.submissions.length, '反向子调用不得创建第二种或额外顶层 Job');
    assert.deepEqual(jobs.map((job) => job.id).sort(), report.submissions.map((job) => job.id).sort());
    record.top_level_jobs = jobs.length;
    await api.manage(composePlugin, 'unload', 'mcp');
    const catalog = await api.catalog();
    assert.equal(catalog.some((item) => item.service.id === compose), false);
    assert.equal(catalog.find((item) => item.service.id === normalize).available, true);
    await api.rejectService(compose, text, 404, 'not_found');
    await api.rejectOperation(pingOperation, {}, 404, 'not_found');
    await api.manage(composePlugin, 'load');
    await composeSuccess();
  });
  // 最后一项故意保留父子活动调用，由唯一收尾路径请求宿主退出并验证两个进程结束。
  const call = await holdCall('http');
  report.shutdown_call = call;
  report.scenarios.push({ name: '宿主退出撤销父子调用并释放端口', passed: false, job_id: call.task.id });
  context.shutdownProof = async () => {
    const record = report.scenarios.at(-1);
    record.processes = [await processProof(directories.compose, call.parent, true),
      await processProof(directories.normalize, call.child, true)];
    record.passed = true;
  };
  report.example_manifests = { compose: consumer.path, normalize: provider.path };
}
