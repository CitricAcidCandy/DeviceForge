import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createClient, poll } from './device-provider/client.mjs';
import { events, exited } from './device-provider/fixtures.mjs';
import { inputs } from './operation-alias/config.mjs';
import { verify, verifyArtifacts, verifyLifecycle } from './operation-alias/checks.mjs';

// 此脚本只运行主代理已构建宿主，不编译，不模拟 HTTP/MCP 响应。
const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.slice(2).every((value) => value === '--release'), '仅接受 --release');
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend', 'target', profile, `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
const report = { timestamp: new Date().toISOString(), profile, platform: process.platform, architecture: process.arch,
  scope: '当前真实Rust HTTP/MCP、部署静态绑定及协议2/3模拟插件与产物发布；不含完整旧平台迁出、真机或发现兼容',
  passed: false, checks: [], stage: '检查当前宿主' };
let directory, child, closed, client, fixture, spawnError;

async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}

async function logs() {
  const names = (await readdir(join(directory, 'logs'))).filter((name) => name.endsWith('.jsonl'));
  const text = (await Promise.all(names.map((name) => readFile(join(directory, 'logs', name), 'utf8')))).join('\n');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function retainFailureEvidence() {
  // 报告只索引完整证据；原日志和夹具标记留在本次目录，不复制请求正文。
  report.temporary_retained = directory;
  report.temporary_removed = false;
  report.failure_evidence = { indexed_at: new Date().toISOString(), directory,
    bindings: 'operation-bindings.json', markers: 'markers', host_logs: 'logs' };
  report.failure_log_files = [];
  try {
    const names = (await readdir(join(directory, 'logs'))).filter((name) => name.endsWith('.jsonl')).sort();
    for (const name of names) {
      const path = join('logs', name);
      try {
        const bytes = await readFile(join(directory, path));
        report.failure_log_files.push({ path, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      } catch (error) {
        report.failure_log_files.push({ path, error_name: error.name, error_code: error.code });
      }
    }
  } catch (error) {
    report.failure_log_index_error = { name: error.name, code: error.code };
  }
  try {
    report.failure_logs = (await logs()).filter((record) => ['合作插件资源未确认清理', '任务执行失败',
      '插件生命周期变更结束'].includes(record.fields?.message)).slice(-15);
  } catch (error) {
    report.failure_log_read_error = { name: error.name, code: error.code };
  }
}

try {
  const bytes = await readFile(binary);
  report.host = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  directory = await mkdtemp(join(tmpdir(), 'deviceforge-alias-smoke-'));
  fixture = await inputs(directory);
  const configBytes = await readFile(fixture.path);
  report.bindings = { format_version: fixture.config.format_version, count: fixture.config.bindings.length,
    sha256: createHash('sha256').update(configBytes).digest('hex'), bytes: configBytes.length };
  const port = await reservePort(); const base = `http://127.0.0.1:${port}`;
  const plugins = join(directory, 'server-plugins'); const browser = join(directory, 'browser-plugins');
  await mkdir(plugins); await mkdir(browser);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)));
  const env = { ...inherited, APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: directory,
    APK_PLUGIN_DIR: plugins, APK_BROWSER_PLUGIN_DIR: browser, APK_OPERATION_BINDINGS: fixture.path,
    APK_MCP_HOSTS: `127.0.0.1:${port}`, APK_MCP_ORIGINS: base, DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000' };
  child = spawn(binary, [], { cwd: join(root, 'backend'), env, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => { spawnError = error; });
  closed = new Promise((done) => child.once('close', (code, signal) => {
    report.server_exit = { code, signal }; done({ code, signal });
  }));
  client = createClient(base, report);
  await poll(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('绑定配置宿主就绪前退出');
    try { await client.json('/api/v2/health'); return true; } catch { return false; }
  }, Boolean, '绑定配置与空插件目录启动');
  delete report.failed_request;
  const context = { ...fixture, client, report };
  report.stage = '注册准入与投影'; await verify(context);
  report.stage = '共享锁取消与重载'; await verifyLifecycle(context);
  report.stage = '真实产物发布与投影'; await verifyArtifacts(context);
  assert.equal(child.exitCode, null, '热装卸期间宿主不能重启');
  report.stage = '退出日志与进程证据';
  await client.post('/api/v2/system/shutdown');
  assert.deepEqual(await Promise.race([closed, delay(10000).then(() => ({ timeout: true }))]), { code: 0, signal: null });
  const records = await logs();
  const serialized = records.map((record) => JSON.stringify(record));
  for (const id of client.logIds) assert.ok(serialized.some((line) => line.includes(id)), '响应日志ID必须真实落盘');
  assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'));
  report.correlated_response_log_ids = client.logIds.size; report.persisted_log_records = records.length;
  report.stage = '完成'; report.passed = true;
} catch (error) {
  report.failure_stage = report.stage;
  report.failed_request ??= report.last_request ? { ...report.last_request } : undefined;
  report.error = String(error.message).slice(0, 1200);
  report.error_location = String(error.stack).split('\n').filter((line) => line.includes('operation-alias')).slice(0, 4);
  process.exitCode = 1;
} finally {
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { await client.post('/api/v2/system/shutdown'); await Promise.race([closed, delay(10000)]); } catch {}
      // 仅终止本脚本直接启动的宿主，不按复用 PID 查找或终止夹具。
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const ended = await Promise.race([closed, delay(5000).then(() => ({ timeout: true }))]);
      assert.ok(!ended.timeout, '自有宿主未退出，保留临时目录');
    }
    report.fixture_processes = [];
    for (const item of fixture ? [fixture.first, fixture.ordinary, fixture.bad, ...fixture.artifacts] : []) {
      const observed = await events(item);
      if (!report.passed) report[`failure_events_${item.id}`] = observed.slice(-25);
      for (const start of observed.filter((event) => event.kind === 'started')) {
        const related = observed.filter((event) => event.request_id === start.request_id);
        assert.ok(related.some((event) => event.kind === 'cleaned'), '夹具缺少清理确认');
        assert.equal(exited(start.pid), true, '夹具进程仍可见，保留目录，不强杀');
        report.fixture_processes.push({ plugin_id: item.id, request_id: start.request_id, operation: start.operation,
          label: start.label, pid: start.pid, cleaned: true, process_exited: true });
      }
    }
    if (directory && report.passed) {
      const within = relative(resolve(tmpdir()), resolve(directory));
      assert.ok(within && !within.startsWith('..') && !isAbsolute(within), '删除临时目录前必须核对绝对路径边界');
      await rm(directory, { recursive: true, force: true });
      report.temporary_removed = true;
    }
  } catch (error) {
    report.failure_stage ??= '夹具与临时目录清理';
    report.passed = false; report.cleanup_error = String(error.message).slice(0, 1000);
    report.temporary_retained = directory; process.exitCode = 1;
  }
  if (directory && !report.passed) await retainFailureEvidence();
  report.completed_at = new Date().toISOString();
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(resolve(root, 'artifacts', `operation-alias-smoke-${profile}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
