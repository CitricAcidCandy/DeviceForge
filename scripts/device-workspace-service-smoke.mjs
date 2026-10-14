import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createClient, poll } from './device-provider/client.mjs';
import { exited } from './device-provider/fixtures.mjs';
import {
  createWorkspaceFixture,
  readWorkspaceEvents,
} from './device-workspace-service/fixture.mjs';

// 使用已构建宿主的冻结副本与全新插件根；不会编译或调用真实设备。
assert.equal(process.argv.length, 2, '此驱动不接受外部服务或真实设备参数');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'artifacts', `device-workspace-service-${randomUUID()}`);
const sourceBinary = resolve(
  root,
  'backend/target/debug',
  `apk-server${process.platform === 'win32' ? '.exe' : ''}`,
);
const frozenBinary = join(directory, `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
const reportPath = join(directory, 'report.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  timestamp: new Date().toISOString(),
  scope:
    '当前冻结 debug Rust 宿主、真实 HTTP/MCP、独立 Node 协议3设备夹具；连接仅写夹具状态文件，不含 ADB/HDC、真机、外部网络、浏览器或性能验收',
  passed: false,
  checks: [],
  stage: '冻结输入',
};
let server;
let serverClosed;
let client;
let fixture;
let spawnError;

async function reservePort() {
  const listener = createServer();
  await new Promise((done, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', done);
  });
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())));
  return port;
}

try {
  await mkdir(directory, { recursive: true });
  const identity = await stat(sourceBinary);
  report.host = {
    source: sourceBinary,
    modified_at: identity.mtime.toISOString(),
    bytes: identity.size,
    sha256: digest(await readFile(sourceBinary)),
    frozen: frozenBinary,
  };
  await copyFile(sourceBinary, frozenBinary);
  assert.equal(digest(await readFile(frozenBinary)), report.host.sha256);
  const plugins = join(directory, 'server-plugins');
  const browserPlugins = join(directory, 'browser-plugins');
  const data = join(directory, 'data');
  await Promise.all([mkdir(plugins), mkdir(browserPlugins), mkdir(data)]);
  fixture = await createWorkspaceFixture(directory);
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  client = createClient(base, report);
  report.base_url = base;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
  );
  const env = {
    ...environment,
    APK_BIND: `127.0.0.1:${port}`,
    APK_DATA_DIR: data,
    APK_PLUGIN_DIR: plugins,
    APK_BROWSER_PLUGIN_DIR: browserPlugins,
    DEVICEFORGE_NODE: process.execPath,
    APK_MCP_HOSTS: `127.0.0.1:${port}`,
    APK_MCP_ORIGINS: base,
    DEVICEFORGE_HTTP_RATE: '10000',
  };
  assert.equal(Object.hasOwn(env, 'APK_API_TOKEN'), false);
  server = spawn(frozenBinary, [], { cwd: directory, env, stdio: 'ignore', windowsHide: true });
  server.on('error', (error) => {
    spawnError = error;
  });
  serverClosed = new Promise((done) =>
    server.once('close', (code, signal) => {
      report.server_exit = { code, signal, at: new Date().toISOString() };
      done({ code, signal });
    }),
  );
  report.server_pid = server.pid;
  await poll(
    async () => {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error('受控宿主就绪前退出');
      try {
        await client.json('/api/v2/health');
        return true;
      } catch {
        return false;
      }
    },
    Boolean,
    '独占空插件根启动',
  );
  delete report.failed_request;
  assert.deepEqual(await client.json('/api/v2/device-providers'), []);
  assert.deepEqual(await client.json('/api/v2/devices'), []);
  report.checks.push({ name: '全新免鉴权数据根启动，无加载设备提供者', passed: true });
  report.stage = '安装与显式发现';
  const installed = await client.json('/api/v2/plugin-packages/server?format=tgz', {
    method: 'POST',
    status: 201,
    headers: { 'content-type': 'application/gzip' },
    body: fixture.archive,
  });
  assert.equal(installed.id, fixture.id);
  await client.manage(fixture.id, 'load');
  assert.deepEqual(await readWorkspaceEvents(fixture), [], '安装加载不能隐式执行发现');
  const providers = await client.json('/api/v2/device-providers');
  assert.equal(providers.length, 1);
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), providers);
  const provider = providers[0];
  assert.equal(provider.id, fixture.id);
  const first = await client.refresh(provider);
  assert.ok(first.observed_at >= Date.now() - 30000 && first.observed_at <= Date.now());
  assert.deepEqual(
    first.devices.map((device) => device.state),
    ['online', 'offline', 'unauthorized'],
  );
  assert.deepEqual(await client.json('/api/v2/devices'), [first]);
  assert.deepEqual(await client.tool('deviceforge.list_devices'), [first]);
  await client.finished(first.discovery_job_id);
  report.initial_directory = first;
  report.checks.push({
    name: '在线安装/加载无隐式发现，显式发现返回当前代身份、三状态、Unix毫秒及共享任务',
    passed: true,
  });
  report.stage = '能力与连接任务';
  const action = (capability, deviceId, input) => ({
    provider_id: provider.id,
    generation: provider.generation,
    capability,
    version: 1,
    device_id: deviceId,
    input,
  });
  const listed = await client.finished(
    (await client.action(action('packages', 'fixture-usb-online', {}))).id,
  );
  assert.match(listed.result.result.output, /package:org\.deviceforge\.fixture/);
  assert.deepEqual(listed.result.artifacts, []);
  const connected = await client.finished(
    (await client.action(action('connect', null, { address: 'fixture.invalid:5555' }))).id,
  );
  assert.equal(connected.result.result.connected, true);
  assert.equal(connected.result.result.synthetic_device, true);
  assert.deepEqual(await client.json('/api/v2/devices'), [first], '连接完成不会自动刷新目录');
  const second = await client.refresh(provider);
  assert.equal(second.devices.length, 4);
  assert.ok(second.devices.some((device) => device.reference.local_id === 'fixture.invalid:5555'));
  const disconnected = await client.finished(
    (await client.action(action('disconnect', null, { address: 'fixture.invalid:5555' }), 'mcp'))
      .id,
  );
  assert.equal(disconnected.result.result.connected, false);
  const third = await client.tool('deviceforge.refresh_devices', {
    id: provider.id,
    generation: provider.generation,
  });
  assert.equal(third.devices.length, 3);
  assert.ok(!third.devices.some((device) => device.reference.local_id === 'fixture.invalid:5555'));
  await client.finished(third.discovery_job_id);
  report.tasks = {
    packages: { id: listed.id, operation: listed.operation, status: listed.status },
    connect: { id: connected.id, operation: connected.operation, status: connected.status },
    disconnect: {
      id: disconnected.id,
      operation: disconnected.operation,
      status: disconnected.status,
    },
    discovery: [first, second, third].map((item) => ({
      id: item.discovery_job_id,
      observed_at: item.observed_at,
      devices: item.devices.length,
    })),
  };
  report.checks.push({
    name: '真实共享任务读取应用、HTTP连接并显式发现新增设备、MCP断开并显式发现撤销设备',
    passed: true,
  });
  await client.post('/api/v2/device-actions', action('packages', 'fixture-offline', {}), {
    status: 409,
    code: 'conflict',
  });
  await client.post(
    '/api/v2/device-actions',
    { ...action('packages', 'fixture-usb-online', {}), generation: 'stale-generation' },
    { status: 409, code: 'conflict' },
  );
  report.checks.push({ name: '离线与旧代次严格409 conflict拒绝', passed: true });
  report.stage = '退出与关联';
  assert.equal((await client.post('/api/v2/system/shutdown')).stopping, true);
  assert.deepEqual(
    await Promise.race([serverClosed, delay(10000).then(() => ({ timeout: true }))]),
    { code: 0, signal: null },
  );
  const portReleased = await poll(
    async () => {
      try {
        await fetch(`${base}/api/v2/health`, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    },
    Boolean,
    '本次随机端口释放',
    5000,
  );
  report.port_released = portReleased;
  const records = (
    await Promise.all(
      (await readdir(join(data, 'logs')))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => readFile(join(data, 'logs', name), 'utf8')),
    )
  ).join('\n');
  for (const logId of client.logIds) assert.ok(records.includes(logId), 'HTTP/MCP日志ID必须落盘');
  const events = await readWorkspaceEvents(fixture);
  const started = events.filter((event) => event.kind === 'started');
  assert.equal(started.length, 6);
  for (const event of started) {
    assert.ok(
      events.some((item) => item.kind === 'cleaned' && item.request_id === event.request_id),
    );
    assert.ok(
      events.some((item) => item.kind === 'process_exit' && item.request_id === event.request_id),
    );
    assert.ok(exited(event.pid), '本次Node插件必须已真实退出');
  }
  report.plugin_processes = started.map(({ pid, operation, request_id }) => ({
    pid,
    operation,
    request_id,
    exited: true,
  }));
  report.correlated_log_ids = client.logIds.size;
  report.checks.push({
    name: '宿主正常exit0、全部6次插件进程退出、随机端口释放、HTTP/MCP日志落盘',
    passed: true,
  });
  assert.equal(
    digest(await readFile(sourceBinary)),
    report.host.sha256,
    '源宿主在受检期间不得改变',
  );
  assert.equal(
    digest(await readFile(frozenBinary)),
    report.host.sha256,
    '冻结宿主在受检期间不得改变',
  );
  report.input_stable = true;
  report.passed = true;
} catch (error) {
  report.failure = { stage: report.stage, message: String(error.message).slice(0, 1200) };
  process.exitCode = 1;
} finally {
  // 只回收本驱动拥有的宿主；证据目录一直保留，失败不覆盖其他运行报告。
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    try {
      await client?.post('/api/v2/system/shutdown');
      await Promise.race([serverClosed, delay(5000)]);
    } catch {}
    if (server.exitCode === null && server.signalCode === null) server.kill();
    const stopped = await Promise.race([serverClosed, delay(5000).then(() => ({ timeout: true }))]);
    report.failure_shutdown = stopped;
    if (stopped.timeout) {
      report.passed = false;
      process.exitCode = 1;
    }
  }
  if (fixture) {
    const events = await readWorkspaceEvents(fixture);
    report.remaining_plugin_pids = [
      ...new Set(events.filter((item) => item.kind === 'started').map((item) => item.pid)),
    ].filter((pid) => !exited(pid));
    if (report.remaining_plugin_pids.length) {
      report.passed = false;
      process.exitCode = 1;
    }
  }
  report.completed_at = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      report: reportPath,
      failure: report.failure,
      remaining_plugin_pids: report.remaining_plugin_pids,
    }),
  );
}
