import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { smokeBinary } from './smoke-binaries.mjs';

// 只使用已有构建产物；由主代理统一构建，避免与共享工作区的门禁争用。
const backend = fileURLToPath(new URL('../', import.meta.url));
const profile = process.argv.includes('--release') ? 'release' : 'debug';
assert.ok(process.argv.slice(2).every((value) => value === '--release'), '仅支持 --release 参数');
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = (name) => smokeBinary(name, profile);
const reportPath = resolve(backend, '..', 'artifacts', `cooperative-smoke-${profile}.json`);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const pluginId = 'cooperative_demo';
const operation = `plugin.${pluginId}.wait`;
const report = {
  timestamp: new Date().toISOString(), profile, platform: process.platform, architecture: process.arch,
  scope: '本机真实 HTTP/MCP、协议 3 原生独立进程和可信插件/管理员受控标记；显式令牌验证可选鉴权路径；不含 Frida、常驻协议、设备提供者或真机',
  passed: false, scenarios: [],
};

async function poll(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw new Error(`等待超时：${label}`);
}

async function optionalFile(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

async function reservePort() {
  const reservation = createServer();
  await new Promise((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', done);
  });
  const port = reservation.address().port;
  await new Promise((done, reject) => reservation.close((error) => error ? reject(error) : done()));
  return port;
}

function logField(record, name) {
  return record.fields?.[name] ?? record.span?.[name]
    ?? record.spans?.findLast((span) => span[name] !== undefined)?.[name];
}

async function scenario(mode, manifest) {
  // 每种模式独立启动空目录，失败状态不能通过重载或换 ID 隐藏。
  const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-cooperative-'));
  const plugins = join(temporary, 'plugins');
  const markers = join(temporary, 'markers');
  const token = randomBytes(32).toString('hex');
  const result = { mode, passed: false, empty_start: false, management_log_ids: [] };
  report.scenarios.push(result);
  let child;
  let closed;
  let graceful = false;
  let pluginPid;
  let base;
  let requestId = 0;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function call(path, options = {}) {
    const before = performance.now();
    const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000), ...options });
    const body = await response.json();
    const logId = response.headers.get('x-deviceforge-log-id');
    result.last_request = { method: options.method ?? 'GET', path, status: response.status,
      log_id: logId, elapsed_ms: performance.now() - before };
    assert.match(logId, uuid, 'HTTP 响应必须有服务端日志 ID');
    if (path.startsWith('/api/v2/')) assert.equal(body.log_id, logId);
    return { response, body, logId };
  }

  async function rpc(method, params = {}) {
    const id = ++requestId;
    const reply = await call('/mcp', { method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    assert.equal(reply.response.status, 200);
    assert.equal(reply.body.id, id);
    assert.equal(reply.body.error ? reply.body.error.data.log_id
      : reply.body.result._meta['deviceforge/log_id'], reply.logId);
    return reply;
  }

  async function tool(name, arguments_ = {}, errorCode) {
    const reply = await rpc('tools/call', { name, arguments: arguments_ });
    assert.equal(reply.body.error, undefined, '业务失败应使用 MCP 工具错误结构');
    assert.equal(reply.body.result.isError, Boolean(errorCode));
    if (errorCode) assert.equal(reply.body.result.structuredContent.code, errorCode);
    return { ...reply, data: reply.body.result.structuredContent };
  }

  async function manage(action, { transport = 'http', errorCode, status = 200 } = {}) {
    const reply = transport === 'http'
      ? await call(`/api/v2/plugins/${pluginId}/${action}`, { method: 'POST' })
      : await tool(`deviceforge.${action}_plugin`, { id: pluginId }, errorCode);
    result.management_log_ids.push({ action, transport, log_id: reply.logId,
      code: transport === 'http' ? reply.body.error?.code ?? 'ok' : reply.data?.code ?? 'ok' });
    if (transport === 'http') {
      if (reply.response.status !== status || (errorCode && reply.body.error?.code !== errorCode)) {
        result.failed_management = { action, transport, expected_status: status,
          actual_status: reply.response.status, expected_code: errorCode ?? 'ok',
          actual_code: reply.body.error?.code ?? 'ok', log_id: reply.logId };
      }
      assert.equal(reply.response.status, status);
      if (errorCode) assert.equal(reply.body.error.code, errorCode);
    }
    return transport === 'http' ? reply.body.data : reply.data;
  }

  async function tools() {
    const all = [];
    let cursor;
    do {
      const reply = await rpc('tools/list', cursor ? { cursor } : {});
      assert.equal(reply.body.error, undefined);
      all.push(...reply.body.result.tools);
      assert.ok(all.length <= 4200, 'MCP 工具分页必须有界');
      assert.notEqual(reply.body.result.nextCursor, cursor ?? '', '分页游标必须推进');
      cursor = reply.body.result.nextCursor;
    } while (cursor);
    return all;
  }

  async function job(id) {
    const reply = await call(`/api/v2/jobs/${id}`);
    assert.equal(reply.response.status, 200);
    return reply.body.data;
  }

  try {
    await mkdir(plugins);
    await mkdir(markers);
    const port = await reservePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(binary('apk-server'), [], { cwd: backend,
      env: { ...environment, APK_API_TOKEN: token, APK_BIND: `127.0.0.1:${port}`,
        APK_DATA_DIR: temporary, APK_PLUGIN_DIR: plugins, DEVICEFORGE_USER_DIR: join(temporary, 'user', '.deviceforge'), DEVICEFORGE_HTTP_RATE: '10000' },
      stdio: 'ignore', windowsHide: true });
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    closed = new Promise((done) => child.once('close', (code) => done({ code })));
    await poll(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('合作协议服务就绪前退出');
      try { return (await call('/api/v2/health')).response.ok; } catch { return false; }
    }, Boolean, `${mode} 空插件服务启动`);
    const initial = await call('/api/v2/plugins');
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.body.data, []);
    assert.deepEqual((await tool('deviceforge.list_plugins')).data, []);
    result.empty_start = true;

    // 路径只进入管理员部署清单，所有业务 HTTP/MCP 请求只含插件 ID 和等待时间。
    const directory = join(plugins, pluginId);
    await mkdir(directory);
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ ...manifest,
      executable: binary('deviceforge-cooperative-demo-plugin'),
      args: mode === 'complete' ? [markers] : [markers, mode] }, null, 2)}\n`, 'utf8');
    const loaded = await manage('load', { transport: mode === 'failed' ? 'mcp' : 'http' });
    assert.equal(loaded.id, pluginId);
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    assert.ok((await tools()).some((item) => item.name === operation));

    const input = { duration_ms: 60000 };
    const submitted = mode === 'ignore'
      ? await tool(operation, input)
      : await call('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ operation, input }) });
    if (mode !== 'ignore') assert.equal(submitted.response.status, 202);
    const task = mode === 'ignore' ? submitted.data : submitted.body.data;
    result.job_id = task.id;
    result.submit_log_id = submitted.logId;
    pluginPid = await poll(async () => {
      const text = await optionalFile(join(markers, 'started'));
      return text && /^\d+$/.test(text) ? Number(text) : undefined;
    }, (pid) => Number.isSafeInteger(pid) && pid > 0, `${mode} 原生进程启动标记`);
    assert.notEqual(pluginPid, child.pid);
    assert.equal(exited(pluginPid), false, '取消前原生插件进程必须存活');
    assert.equal((await job(task.id)).status, 'running');
    assert.equal(await optionalFile(join(markers, 'cleaned')), undefined);
    assert.equal(await optionalFile(join(markers, 'cancel_received')), undefined);
    result.plugin_pid = pluginPid;

    const before = performance.now();
    let detached;
    try {
      detached = await manage('unload');
    } finally {
      // 失败响应也保留耗时，不能把资源确认失败当作普通请求超时。
      result.unload_ms = performance.now() - before;
    }
    // 必须在卸载返回时观察，不能用随后等待掩盖提前返回。
    assert.equal(exited(pluginPid), true, '卸载返回时原生插件进程必须已退出');
    const cleaned = await optionalFile(join(markers, 'cleaned'));
    const cancellation = await optionalFile(join(markers, 'cancel_received'));
    assert.equal(cancellation, mode === 'ignore' ? undefined : '已收到取消令牌');
    result.cancel_notification_received = cancellation !== undefined;
    result.process_exited_at_unload_return = true;
    result.cleaned_marker_at_unload_return = cleaned !== undefined;
    assert.equal(detached.state, 'unloaded');
    assert.equal(detached.cleanup_failed, mode !== 'complete');
    assert.equal(detached.generation, loaded.generation);
    if (mode === 'complete') {
      assert.equal(detached.state, 'unloaded');
      assert.equal(detached.cleanup_failed, false);
      assert.equal(detached.generation, loaded.generation);
      assert.equal(cleaned, '自有资源已清理');
    } else {
      assert.equal(cleaned, undefined, '清理失败不能产生成功标记');
    }
    // 已确认清理保留取消终态；未确认资源必须保留清理失败，不能被取消原因掩盖。
    const expectedStatus = mode === 'complete' ? 'cancelled' : 'failed';
    const expectedError = mode === 'complete'
      ? null
      : '插件结束时未能确认清理完成，请查看对应任务详情；无关操作不受此记录影响';
    const terminal = await job(task.id);
    assert.equal(terminal.status, expectedStatus, '卸载后的历史任务必须保留对应的唯一终态');
    assert.equal(terminal.error, expectedError, '历史原因必须精确区分取消和资源清理未确认');
    assert.deepEqual((await tool('deviceforge.get_job', { id: task.id })).data, terminal,
      'HTTP/MCP 必须返回相同历史任务及清理原因');
    const listed = await call('/api/v2/plugins');
    assert.equal(listed.response.status, 200);
    assert.deepEqual((await tool('deviceforge.list_plugins')).data, listed.body.data);
    assert.deepEqual(listed.body.data, [], '真实调用已排空后，旧告警不能永久占住插件注册');
    result.detached_state = { state: detached.state, cleanup_failed: detached.cleanup_failed,
      generation: detached.generation };
    const operations = await call('/api/v2/operations');
    assert.equal(operations.response.status, 200);
    assert.ok(!operations.body.data.some((item) => item.id === operation));
    assert.ok(!(await tools()).some((item) => item.name === operation));
    const unavailable = await call('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ operation, input }) });
    assert.equal(unavailable.response.status, 404);
    assert.equal(unavailable.body.error.code, 'not_found');
    await tool(operation, input, 'not_found');
    result.http_mcp_operation_revoked = true;
    result.http_mcp_plugin_list_equal = true;

    // 切换到正常夹具后必须实际跑通下一笔，不能只证明删除了旧拒绝断言。
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ ...manifest,
      executable: binary('deviceforge-cooperative-demo-plugin'), args: [markers] }, null, 2)}\n`, 'utf8');
    const reloaded = await manage('load', { transport: 'mcp' });
    assert.notEqual(reloaded.generation, loaded.generation);
    assert.equal(reloaded.cleanup_failed, false);
    const next = await tool(operation, { duration_ms: 1 });
    const succeeded = await poll(() => job(next.data.id),
      (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status), '新代际独立调用完成');
    assert.equal(succeeded.status, 'succeeded');
    assert.notEqual(succeeded.id, task.id);
    result.independent_success = { job_id: succeeded.id, log_id: next.logId };
    const unloaded = await manage('unload', { transport: 'mcp' });
    assert.equal(unloaded.state, 'unloaded');
    result.successful_reload_new_generation = true;
    await delay(100);
    assert.deepEqual(await job(task.id), terminal, '晚到结果不得覆盖历史终态及原因');
    result.history_status = expectedStatus;
    result.history_error = expectedError;
    const shutdown = await call('/api/v2/system/shutdown', { method: 'POST' });
    assert.equal(shutdown.response.status, 200);
    assert.equal(shutdown.body.data.stopping, true);
    assert.deepEqual(await Promise.race([closed, delay(10000).then(() => ({ timeout: true }))]), { code: 0 });
    graceful = true;
    result.graceful_shutdown = true;

    // 优雅关闭刷新后读取真正的 JSONL；报告仅保存受控事件字段，不复制原始插件输出。
    const logDirectory = join(temporary, 'logs');
    const names = (await readdir(logDirectory)).filter((name) => name.endsWith('.jsonl'));
    assert.ok(names.length > 0, '宿主日志必须落盘');
    const logText = (await Promise.all(names.map((name) => readFile(join(logDirectory, name), 'utf8')))).join('\n');
    assert.ok(!logText.includes(token), '落盘日志不得包含访问令牌');
    const records = logText.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    const correlated = (record, logId) => JSON.stringify(record).includes(logId);
    for (const management of result.management_log_ids) {
      for (const message of ['插件生命周期变更开始', '插件生命周期变更结束']) {
        assert.ok(records.some((record) => record.fields?.message === message && correlated(record, management.log_id)),
          '成功和失败管理请求都必须保留日志关联');
      }
      assert.ok(records.some((record) => record.fields?.message === '插件生命周期变更结束'
        && correlated(record, management.log_id) && record.fields.code === management.code));
    }
    const finished = records.find((record) => record.fields?.message === '插件调用结束'
      && correlated(record, task.id) && correlated(record, submitted.logId));
    assert.ok(finished, '原生插件结束日志必须关联提交请求与历史任务');
    assert.equal(finished.fields.code, mode === 'complete' ? 'cancelled' : 'cleanup_failed',
      '调用结束日志必须保留精确取消或清理失败原因');
    const pluginRequestId = logField(finished, 'plugin_request_id');
    assert.match(pluginRequestId, uuid);
    const resourceRecords = records.filter((record) => ['合作插件取消清理已确认', '合作插件资源未确认清理']
      .includes(record.fields?.message) && correlated(record, task.id));
    const expectedMessage = mode === 'complete' ? '合作插件取消清理已确认' : '合作插件资源未确认清理';
    const resource = resourceRecords.find((record) => record.fields.message === expectedMessage);
    assert.ok(resource, '资源清理确认或告警必须真正落盘');
    assert.ok(correlated(resource, submitted.logId));
    assert.equal(logField(resource, 'plugin_request_id'), pluginRequestId);
    assert.equal(resource.fields.cleanup, mode === 'complete' ? 'complete' : 'unresolved');
    if (mode !== 'complete') assert.equal(resource.level, 'WARN');
    assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'));
    assert.ok(records.some((record) => record.fields?.message === '响应流已结束' && correlated(record, shutdown.logId)));
    result.persisted_log_records = records.length;
    result.plugin_request_id = pluginRequestId;
    result.shutdown_log_id = shutdown.logId;
    result.persisted_resource_events = resourceRecords.map((record) => ({
      level: record.level, message: record.fields.message, cleanup: record.fields.cleanup,
      log_id: logField(record, 'log_id'), job_id: logField(record, 'job_id'),
      plugin_id: logField(record, 'plugin_id'), plugin_request_id: logField(record, 'plugin_request_id'),
    }));
    result.passed = true;
  } catch (error) {
    result.error = String(error.message).replaceAll(token, '[已脱敏]').slice(0, 1500);
    result.error_location = String(error.stack).split('\n')
      .filter((line) => line.includes('cooperative-smoke.mjs')).slice(0, 4)
      .map((line) => line.trim().replaceAll(token, '[已脱敏]'));
    try {
      result.failure_markers = {};
      for (const name of ['started', 'cancel_received', 'cleaned']) {
        const path = join(markers, name);
        const value = await optionalFile(path);
        result.failure_markers[name] = { exists: value !== undefined,
          ...(value !== undefined ? { modified_at: (await stat(path)).mtime.toISOString() } : {}) };
      }
      result.process_exited_at_failure = pluginPid ? exited(pluginPid) : undefined;
    } catch (diagnosticError) {
      result.marker_diagnostic_error = String(diagnosticError.message).replaceAll(token, '[已脱敏]').slice(0, 500);
    }
    throw new Error(`${mode} 场景失败：${result.error}`, { cause: error });
  } finally {
    // 失败也先请求自有服务正常关闭，再只终止本脚本直接启动的 ChildProcess。
    if (child?.pid && child.exitCode === null && child.signalCode === null && !graceful) {
      try {
        await fetch(`${base}/api/v2/system/shutdown`, { method: 'POST', headers, signal: AbortSignal.timeout(3000) });
        await Promise.race([closed, delay(10000)]);
      } catch {}
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const stopped = await Promise.race([closed, delay(5000).then(() => ({ timeout: true }))]);
      if (stopped.timeout) throw new Error('本次宿主进程未能退出，保留本次目录供主代理检查');
      result.failure_shutdown = stopped;
    }
    if (!result.passed) {
      // 临时目录删除前只保留受控事件摘要，避免失败时丢失真实资源告警证据。
      try {
        const logDirectory = join(temporary, 'logs');
        const names = (await readdir(logDirectory)).filter((name) => name.endsWith('.jsonl'));
        const records = (await Promise.all(names.map((name) => readFile(join(logDirectory, name), 'utf8'))))
          .join('\n').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
        const messages = ['插件生命周期变更开始', '插件生命周期变更结束', '插件调用结束',
          '合作插件取消清理已确认', '合作插件资源未确认清理', '宿主运行已结束'];
        result.failure_log_events = records.filter((record) => messages.includes(record.fields?.message))
          .slice(-30).map((record) => ({ timestamp: record.timestamp, level: record.level,
            message: record.fields.message, code: record.fields.code, cleanup: record.fields.cleanup,
            log_id: logField(record, 'log_id'), job_id: logField(record, 'job_id'),
            plugin_id: logField(record, 'plugin_id'), plugin_request_id: logField(record, 'plugin_request_id') }));
      } catch (diagnosticError) {
        result.log_diagnostic_error = String(diagnosticError.message).replaceAll(token, '[已脱敏]').slice(0, 500);
      }
    }
    const marker = await optionalFile(join(markers, 'started'));
    const ownedPid = pluginPid ?? (marker && /^\d+$/.test(marker) ? Number(marker) : undefined);
    if (ownedPid && !exited(ownedPid)) {
      // 不对可复用的 PID 强行发信号，避免误杀无关进程；主代理应检查宿主清理边界。
      result.temporary_retained = temporary;
      throw new Error('本次插件进程仍可见，保留本次目录供主代理检查；未终止其他进程');
    }
    const target = resolve(temporary);
    const within = relative(resolve(tmpdir()), target);
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('合作取消测试清理路径越界');
    await rm(target, { recursive: true, force: true });
    result.temporary_removed = true;
  }
}

try {
  for (const name of ['apk-server', 'deviceforge-cooperative-demo-plugin']) {
    assert.ok((await stat(binary(name))).isFile(), `缺少 ${profile} 原生程序，请由主代理统一构建 ${name}`);
  }
  const manifest = JSON.parse(await readFile(join(backend, 'plugins/cooperative-demo/manifest.example.json'), 'utf8'));
  assert.equal(manifest.id, pluginId);
  assert.equal(manifest.protocol_version, 3);
  for (const mode of ['complete', 'ignore', 'failed']) await scenario(mode, manifest);
  report.passed = true;
} catch (error) {
  report.error = String(error.message).slice(0, 1500);
  process.exitCode = 1;
} finally {
  report.completed_at = new Date().toISOString();
  await mkdir(resolve(backend, '..', 'artifacts'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
