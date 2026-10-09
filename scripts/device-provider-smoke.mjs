import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createClient, poll } from './device-provider/client.mjs';
import { events, exited, fixture } from './device-provider/fixtures.mjs';
import { verifyDiscovery } from './device-provider/discovery.mjs';
import { verifyActions } from './device-provider/actions.mjs';
import { verifyLifecycle } from './device-provider/lifecycle.mjs';

// 只使用集成负责人已构建的当前宿主；此脚本不编译、不分发、不修改部署工作区。
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.every((value) => value === '--release'), '仅支持 --release 参数');
const profile = args.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend', 'target', profile, `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
const reportPath = resolve(root, 'artifacts', `device-provider-smoke-${profile}.json`);
const report = { timestamp: new Date().toISOString(), profile, platform: process.platform, architecture: process.arch,
  scope: '本机默认免鉴权真实 Rust HTTP/MCP，两个可信第三方 Node 协议 3 模拟提供者在线 TGZ 安装、设备目录/动作/互斥/取消与热装卸；标记只证明夹具进程和自有计时器清理，不含真机、常驻传输、浏览器 UI、跨平台或分发验收',
  passed: false, checks: [], stage: '检查当前构建' };
let temporary;
let child;
let closed;
let client;
let spawnError;
let graceful = false;
const fixtures = [];

async function reservePort() {
  const listener = createServer();
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close((error) => error ? reject(error) : done()));
  return port;
}

async function logs() {
  const directory = join(temporary, 'logs');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0, '真实服务日志必须落盘');
  const text = (await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))).join('\n');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

try {
  assert.ok((await stat(binary)).isFile(), `缺少 ${profile} 宿主，请等待主代理构建`);
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-provider-smoke-'));
  const plugins = join(temporary, 'server-plugins');
  const browserPlugins = join(temporary, 'browser-plugins');
  await mkdir(plugins); await mkdir(browserPlugins);
  fixtures.push(await fixture('provider_smoke_a', join(temporary, 'markers')));
  fixtures.push(await fixture('provider_smoke_b', join(temporary, 'markers')));
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  client = createClient(base, report);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)));
  const env = { ...environment, APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: temporary,
    APK_PLUGIN_DIR: plugins, APK_BROWSER_PLUGIN_DIR: browserPlugins, DEVICEFORGE_NODE: process.execPath,
    APK_MCP_HOSTS: `127.0.0.1:${port}`, APK_MCP_ORIGINS: base, DEVICEFORGE_HTTP_RATE: '10000' };
  assert.equal(Object.hasOwn(env, 'APK_API_TOKEN'), false);
  child = spawn(binary, [], { cwd: join(root, 'backend'), env, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => { spawnError = error; });
  child.once('exit', (code, signal) => { report.server_exit = { code, signal, at: new Date().toISOString() }; });
  closed = new Promise((done) => child.once('close', (code, signal) => {
    report.server_close = { code, signal, at: new Date().toISOString() };
    done({ code, signal });
  }));
  await poll(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('设备提供者服务就绪前退出');
    try { await client.json('/api/v2/health'); return true; } catch { return false; }
  }, Boolean, '空部署目录默认免令牌启动');
  delete report.failed_request;
  report.server_pid = child.pid; report.default_without_token = true;
  assert.deepEqual(await client.json('/api/v2/plugins'), []);
  assert.deepEqual(await client.json('/api/v2/plugin-packages/server'), []);
  assert.deepEqual(await client.json('/api/v2/device-providers'), []);
  report.stage = '在线包安装与设备声明';
  const before = (await readdir(plugins)).sort();
  await client.json('/api/v2/plugin-packages/server?format=tgz', { method: 'POST', status: 400, code: 'invalid_input',
    headers: { 'content-type': 'application/gzip' }, body: fixtures[0].invalidArchive });
  await poll(async () => (await readdir(plugins)).sort(), (value) => isDeepStrictEqual(value, before), '坏设备声明无部署/暂存残留', 5000);
  assert.deepEqual(await client.json('/api/v2/plugin-packages/server'), []);
  assert.deepEqual(await client.json('/api/v2/device-providers'), []);
  report.checks.push({ name: '坏设备声明安装 400 invalid_input、无部署/贡献残留', passed: true });
  for (const item of fixtures) {
    const installed = await client.json('/api/v2/plugin-packages/server?format=tgz', { method: 'POST', status: 201,
      headers: { 'content-type': 'application/gzip' }, body: item.archive });
    assert.equal(installed.id, item.id); assert.equal(installed.runtime, 'node');
    assert.equal(installed.entry_path, 'dist/index.mjs');
    assert.deepEqual(await events(item), [], '安装不应执行设备入口');
  }
  assert.deepEqual(await client.json('/api/v2/device-providers'), [], '安装不自动加载提供者');
  for (const [index, item] of fixtures.entries()) {
    const loaded = await client.manage(item.id, 'load', index === 0 ? 'http' : 'mcp');
    assert.equal(loaded.id, item.id); assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    assert.deepEqual(await events(item), [], '加载不应隐式执行发现');
  }
  const context = { client, first: fixtures[0], second: fixtures[1], report };
  for (const [stage, verify] of [['发现与身份', verifyDiscovery], ['能力/准入/互斥', verifyActions], ['取消与热装卸', verifyLifecycle]]) {
    report.stage = stage;
    await verify(context);
    assert.equal(child.exitCode, null, '提供者接入和热装卸期间宿主不得重启');
  }
  report.server_restarted = false;
  report.stage = '正常关闭与落盘证据';
  assert.equal((await client.post('/api/v2/system/shutdown')).stopping, true);
  const stopped = await Promise.race([closed, delay(10000).then(() => ({ timeout: true }))]);
  assert.deepEqual(stopped, { code: 0, signal: null });
  graceful = true; report.graceful_shutdown = true;
  const records = await logs();
  const serialized = records.map((record) => JSON.stringify(record));
  for (const logId of client.logIds) assert.ok(serialized.some((text) => text.includes(logId)), 'HTTP/MCP 响应日志 ID 必须落盘');
  for (const id of report.history_jobs) {
    assert.ok(records.some((record) => record.fields?.message === '插件调用结束' && JSON.stringify(record).includes(id)),
      '能力执行结束日志必须关联共享历史任务');
  }
  assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'));
  assert.ok(records.filter((record) => record.fields?.message === '合作插件取消清理已确认').length >= 4);
  assert.ok(!records.some((record) => record.fields?.message === '合作插件资源未确认清理'));
  report.persisted_log_records = records.length;
  report.correlated_response_log_ids = client.logIds.size;
  report.fixture_processes = [];
  for (const item of fixtures) {
    const all = await events(item);
    for (const start of all.filter((event) => event.kind === 'started')) {
      assert.ok(all.some((event) => event.kind === 'cleaned' && event.request_id === start.request_id));
      assert.equal(exited(start.pid), true, '本次每个真实 Node 调用都必须退出');
      report.fixture_processes.push({ provider_id: item.id, request_id: start.request_id,
        pid: start.pid, operation: start.operation, label: start.label, cleaned: true, process_exited: true });
    }
  }
  report.stage = '完成'; report.passed = true;
} catch (error) {
  report.error = String(error.message).slice(0, 1500);
  report.error_location = String(error.stack).split('\n').filter((line) => line.includes('device-provider')).slice(0, 5);
  process.exitCode = 1;
} finally {
  // 即使关闭超时，也必须保留响应写完、输入 EOF 与真正退出的独立证据。
  const captureEvidence = async () => {
    report.fixture_timing = [];
    for (const item of fixtures) {
      const all = await events(item);
      for (const start of all.filter((event) => event.kind === 'started')) {
        const related = all.filter((event) => event.request_id === start.request_id);
        report.fixture_timing.push({ provider_id: item.id, request_id: start.request_id,
          pid: start.pid, label: start.label, process_visible: !exited(start.pid),
          events: related.map(({ kind, at }) => ({ kind, at, timestamp: new Date(at).toISOString() })) });
      }
    }
    if (!report.passed && temporary) {
      for (const item of fixtures) report[`failure_events_${item.id}`] = (await events(item)).slice(-20);
      try {
        report.failure_log_events = (await logs()).filter((record) => ['合作插件资源未确认清理',
          '合作插件取消清理已确认', '插件生命周期变更结束', '插件调用开始', '插件调用结束',
          '宿主运行已结束'].includes(record.fields?.message)).slice(-30)
          .map((record) => ({ timestamp: record.timestamp, level: record.level, fields: record.fields }));
      } catch {}
    }
  };
  try {
    // 只关闭本脚本直接启动的宿主；不对可复用 PID 发终止信号。
    if (child?.pid && child.exitCode === null && child.signalCode === null && !graceful) {
      try { await client.post('/api/v2/system/shutdown'); await Promise.race([closed, delay(10000)]); } catch {}
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const stopped = await Promise.race([closed, delay(5000).then(() => ({ timeout: true }))]);
      await captureEvidence();
      assert.ok(!stopped.timeout, '本次宿主未能退出，保留临时目录');
      report.failure_shutdown = stopped;
    }
    await captureEvidence();
    for (const item of fixtures) {
      const running = (await events(item)).filter((event) => event.kind === 'started' && !exited(event.pid));
      assert.deepEqual(running, [], '本次夹具 PID 仍可见，保留目录并交集成负责人检查；不强杀');
    }
    if (temporary) {
      const within = relative(resolve(tmpdir()), resolve(temporary));
      assert.ok(within && !within.startsWith('..') && !isAbsolute(within), '设备 smoke 临时目录越界');
      await rm(temporary, { recursive: true, force: true });
      report.temporary_removed = true;
    }
  } catch (error) {
    report.passed = false; report.cleanup_error = String(error.message).slice(0, 1000);
    report.temporary_retained = temporary; process.exitCode = 1;
  }
  report.completed_at = new Date().toISOString();
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
