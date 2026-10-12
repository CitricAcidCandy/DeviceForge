import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inside } from '../cli/src/paths.mjs';
import { packNativePlugins } from './native-plugin-package.mjs';

export async function installNativePlugins({ root, temporary, runNpx, prefix, dataDirectory, pluginDirectory, cooperativeMarkers }) {
  const selected = ['artifact_copy', 'cooperative_demo', 'echo', 'msgpack', 'performance_demo', 'settings', 'ai-assistant', 'tool-supply'];
  const packages = await packNativePlugins({ root, destination: temporary, selected });
  assert.deepEqual(packages.map((pkg) => pkg.id).sort(), [...selected].sort());
  for (const pkg of packages) {
    const installed = await runNpx([...prefix, 'plugin', 'install', pkg.archive, '--data-dir', dataDirectory]);
    assert.ok(installed.stdout.includes(`${pkg.id}@${pkg.version} 安装完成`));
  }
  // 只修改本次 npx 安装生成的管理员清单，不通过 HTTP/MCP 传服务器路径。
  assert.ok(inside(temporary, pluginDirectory) && resolve(pluginDirectory) !== resolve(temporary));
  assert.ok(inside(temporary, cooperativeMarkers) && resolve(cooperativeMarkers) !== resolve(temporary));
  await mkdir(cooperativeMarkers);
  const manifestPath = join(pluginDirectory, 'cooperative_demo', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.id, 'cooperative_demo');
  assert.equal(manifest.protocol_version, 3);
  assert.deepEqual(manifest.args, []);
  manifest.args = [cooperativeMarkers];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return packages;
}

export async function verifyNativePlugins({ base, mcp, headers, cooperativeMarkers }) {
  async function finished(id) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/api/v1/jobs/${id}`, { headers, signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      const job = await response.json();
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'succeeded', job.error);
        return job.result;
      }
      await delay(25);
    }
    throw new Error('已安装原生插件任务未在期限内结束');
  }
  async function job(operation, input) {
    const response = await fetch(`${base}/api/v1/jobs`, {
      method: 'POST', headers, body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 202);
    return finished((await response.json()).id);
  }
  let requestId = 10;
  async function rpc(method, params = {}) {
    const id = requestId++;
    const response = await fetch(mcp, {
      method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream', origin: base },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.id, id);
    assert.equal(reply.error, undefined);
    assert.equal(reply.result._meta['deviceforge/log_id'], response.headers.get('x-deviceforge-log-id'));
    return reply.result;
  }
  async function tool(name, input) {
    const result = await rpc('tools/call', { name, arguments: input });
    assert.equal(result.isError, false);
    return result.structuredContent;
  }
  async function mcpJob(name, input) {
    return finished((await tool(name, input)).id);
  }
  async function api(path, options = {}) {
    const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000), ...options });
    const body = await response.json();
    assert.match(response.headers.get('x-deviceforge-log-id'), /^[\da-f-]{36}$/);
    assert.equal(body.log_id, response.headers.get('x-deviceforge-log-id'));
    return { response, body };
  }
  async function content(artifact) {
    const response = await fetch(`${base}/api/v1/artifacts/${artifact.id}/content`, { headers, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, artifact.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    return bytes;
  }

  const echo = { message: '原生插件从 npx 包加载', value: 42 };
  assert.deepEqual(await job('plugin.echo.echo', echo), echo);
  const records = [{ id: 1, name: '设备甲' }, { id: 2, name: '设备乙' }, { id: 3, name: '其他' }];
  const bytes = Buffer.from(JSON.stringify(records));
  const upload = await fetch(`${base}/api/v1/artifacts?filename=npx-records.json`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(3000),
  });
  assert.equal(upload.status, 201);
  const source = await upload.json();
  const copied = await job('plugin.artifact_copy.copy', { artifact_id: source.id });
  assert.notEqual(copied.artifacts[0].id, source.id);
  assert.deepEqual(await content(copied.artifacts[0]), bytes);
  const encoded = await job('plugin.msgpack.encode', { artifact_id: source.id });
  const packed = encoded.artifacts[0];
  assert.equal((await content(packed))[0], 0x93);
  const decoded = await mcpJob('plugin.msgpack.decode', { artifact_id: packed.id });
  assert.deepEqual(JSON.parse((await content(decoded.artifacts[0])).toString('utf8')), records);
  const page = await mcpJob('plugin.msgpack.query', {
    artifact_id: packed.id, offset: 1, limit: 1, filter: { field: 'name', operator: 'contains', value: '设备' },
  });
  assert.equal(page.result.matched, 2);
  assert.deepEqual(page.result.records, [records[1]]);
  const sample = await job('plugin.performance_demo.sample', { device_id: 'synthetic-device', package: 'com.example.demo' });
  assert.equal(sample.result.frame_window.source, 'synthetic_demo');
  assert.equal(sample.result.frame_window.duration_ms, 1000);

  const cooperativeOperation = 'plugin.cooperative_demo.wait';
  async function marker(name) {
    try { return await readFile(join(cooperativeMarkers, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  function processExited(pid) {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }
  async function poll(read, predicate, label) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      await delay(25);
    }
    throw new Error(`原生合作插件等待超时：${label}`);
  }
  async function resetMarkers() {
    // 仅删除本次安装配置的三个测试标记，不递归删除部署目录或源文件。
    for (const name of ['started', 'cleaned', 'cancel_received']) await rm(join(cooperativeMarkers, name), { force: true });
  }
  async function started(id) {
    const pid = await poll(async () => {
      const value = await marker('started');
      return value && /^\d+$/.test(value) ? Number(value) : undefined;
    }, (value) => Number.isSafeInteger(value) && value > 0, '原生进程启动标记');
    assert.equal(processExited(pid), false);
    assert.equal((await api(`/api/v2/jobs/${id}`)).body.data.status, 'running');
    assert.equal(await marker('cleaned'), undefined);
    assert.equal(await marker('cancel_received'), undefined);
    return pid;
  }
  async function cleaned(pid) {
    assert.equal(await marker('cleaned'), '自有资源已清理');
    assert.equal(processExited(pid), true, '确认清理后合作插件进程应已退出');
  }
  await resetMarkers();
  const cooperative = await job(cooperativeOperation, { duration_ms: 25 });
  assert.equal(cooperative.result.synthetic_demo, true);
  assert.equal(cooperative.result.waited_ms, 25);
  const successPid = Number(await marker('started'));
  assert.ok(Number.isSafeInteger(successPid) && successPid > 0);
  await cleaned(successPid);
  await resetMarkers();
  const mcpCooperative = await mcpJob(cooperativeOperation, { duration_ms: 25 });
  assert.equal(mcpCooperative.result.synthetic_demo, true);
  assert.equal(mcpCooperative.result.waited_ms, 25);
  const mcpSuccessPid = Number(await marker('started'));
  assert.ok(Number.isSafeInteger(mcpSuccessPid) && mcpSuccessPid > 0);
  await cleaned(mcpSuccessPid);

  // 显式 MCP 取消先保留 cancelled 历史，随后等待真正清理；卸载则要求返回时已清理。
  await resetMarkers();
  const submitted = await api('/api/v2/jobs', { method: 'POST',
    body: JSON.stringify({ operation: cooperativeOperation, input: { duration_ms: 60000 } }) });
  assert.equal(submitted.response.status, 202);
  const cancelledId = submitted.body.data.id;
  const cancelPid = await started(cancelledId);
  assert.equal((await tool('deviceforge.cancel_job', { id: cancelledId })).status, 'cancelled');
  await poll(async () => (await marker('cleaned')) === '自有资源已清理' && processExited(cancelPid), Boolean, '显式取消清理');
  assert.equal(await marker('cancel_received'), '已收到取消令牌');
  assert.equal((await api(`/api/v2/jobs/${cancelledId}`)).body.data.status, 'cancelled');
  const owners = (await api('/api/v2/plugins')).body.data;
  assert.deepEqual(await tool('deviceforge.list_plugins', {}), owners);
  const loaded = owners.find((owner) => owner.id === 'cooperative_demo');
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.cleanup_failed, false);

  await resetMarkers();
  const waiting = await tool(cooperativeOperation, { duration_ms: 60000 });
  const unloadPid = await started(waiting.id);
  const detached = await api('/api/v2/plugins/cooperative_demo/unload', { method: 'POST' });
  assert.equal(detached.response.status, 200);
  assert.equal(detached.body.data.state, 'unloaded');
  assert.equal(detached.body.data.cleanup_failed, false);
  assert.equal(detached.body.data.generation, loaded.generation);
  await cleaned(unloadPid);
  assert.equal(await marker('cancel_received'), '已收到取消令牌');
  assert.equal((await api(`/api/v2/jobs/${waiting.id}`)).body.data.status, 'cancelled');
  assert.equal((await tool('deviceforge.get_job', { id: waiting.id })).status, 'cancelled');
  const operations = await api('/api/v2/operations');
  assert.equal(operations.response.status, 200);
  assert.ok(!operations.body.data.some((item) => item.id === cooperativeOperation));
  const catalog = await rpc('tools/list');
  assert.ok(!catalog.tools.some((item) => item.name === cooperativeOperation));
  const absent = await api('/api/v2/jobs', { method: 'POST',
    body: JSON.stringify({ operation: cooperativeOperation, input: { duration_ms: 25 } }) });
  assert.equal(absent.response.status, 404);
  assert.equal(absent.body.error.code, 'not_found');
  const rejected = await rpc('tools/call', { name: cooperativeOperation, arguments: { duration_ms: 25 } });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.code, 'not_found');
  const reloaded = await tool('deviceforge.load_plugin', { id: 'cooperative_demo' });
  assert.equal(reloaded.state, 'loaded');
  assert.equal(reloaded.cleanup_failed, false);
  assert.notEqual(reloaded.generation, loaded.generation);
  assert.ok((await rpc('tools/list')).tools.some((item) => item.name === cooperativeOperation));
  assert.equal((await api(`/api/v2/jobs/${waiting.id}`)).body.data.status, 'cancelled');
  assert.equal((await api(`/api/v2/jobs/${cancelledId}`)).body.data.status, 'cancelled');
  return { cooperative_tasks_http_mcp: true, explicit_cancel_cleaned: true,
    unload_cancel_cleaned_at_return: true, reload_new_generation: true };
}
