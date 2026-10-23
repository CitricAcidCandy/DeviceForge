import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { clientFor } from './client.mjs';
import { events, exited } from './fixtures.mjs';
import { smokeBinary } from '../../backend/scripts/smoke-binaries.mjs';

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}等待超时`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function port() {
  const listener = createServer();
  await new Promise((done, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', done);
  });
  const value = listener.address().port;
  await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())));
  return value;
}

export async function readHostLogs(dataDirectory) {
  const directory = join(dataDirectory, 'logs');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  const records = [];
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8');
    records.push(
      ...text
        .slice(0, text.lastIndexOf('\n') + 1)
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse),
    );
  }
  return records;
}

export async function prepareHost(root, profile, report) {
  const binary = smokeBinary('apk-server', profile);
  assert.ok((await stat(binary)).isFile(), '必须等待集成负责人交接当前构建');
  const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-nested-artifacts-'));
  report.temporary_retained = temporary;
  const plugins = join(temporary, 'server-plugins');
  const browser = join(temporary, 'browser-plugins');
  await mkdir(plugins);
  await mkdir(browser);
  const endpoint = await port();
  const base = `http://127.0.0.1:${endpoint}`;
  const { client, download } = clientFor(base, report);
  let child;
  let closed;
  let spawnError;
  let graceful = false;

  const logs = () => readHostLogs(temporary);

  const start = async () => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
    );
    const env = {
      ...environment,
      APK_BIND: `127.0.0.1:${endpoint}`,
      APK_DATA_DIR: temporary,
      DEVICEFORGE_USER_DIR: join(temporary, 'user'),
      APK_PLUGIN_DIR: plugins,
      APK_BROWSER_PLUGIN_DIR: browser,
      DEVICEFORGE_NODE: process.execPath,
      APK_MCP_HOSTS: `127.0.0.1:${endpoint}`,
      APK_MCP_ORIGINS: base,
      DEVICEFORGE_HTTP_RATE: '10000',
    };
    assert.equal(Object.hasOwn(env, 'APK_API_TOKEN'), false);
    child = spawn(binary, [], {
      cwd: join(root, 'backend'),
      env,
      stdio: 'ignore',
      windowsHide: true,
    });
    report.server_pid = child.pid;
    child.on('error', (error) => {
      spawnError = error;
    });
    child.once('exit', (code, signal) => {
      report.server_exit = { code, signal, at: new Date().toISOString() };
    });
    closed = new Promise((done) =>
      child.once('close', (code, signal) => {
        report.server_close = { code, signal, at: new Date().toISOString() };
        done({ code, signal });
      }),
    );
    await poll(
      async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error('宿主在就绪前退出');
        try {
          await client.json('/api/v2/health');
          return true;
        } catch {
          return false;
        }
      },
      Boolean,
      '默认免令牌启动',
      10000,
    );
    delete report.failed_request;
    report.default_without_token = true;
    assert.deepEqual(await client.json('/api/v2/plugins'), []);
    assert.deepEqual(await client.json('/api/v2/device-providers'), []);
    assert.deepEqual(await client.json('/api/v2/plugin-packages/server'), []);
  };

  const shutdown = async () => {
    assert.equal((await client.post('/api/v2/system/shutdown')).stopping, true);
    assert.deepEqual(await bounded(closed, 10000, '宿主正常退出'), { code: 0, signal: null });
    graceful = true;
    report.graceful_shutdown = true;
  };

  const verifyLogs = async () => {
    const records = await logs();
    assert.ok(records.length > 0, '真实日志必须落盘');
    const serialized = records.map((record) => JSON.stringify(record));
    for (const id of client.logIds)
      assert.ok(
        serialized.some((line) => line.includes(id)),
        '每个响应日志 ID 必须落盘',
      );
    assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'));
    assert.ok(
      !records.some((record) => record.fields?.code === 'cleanup_failed'),
      '不得出现未确认资源清理',
    );
    report.persisted_log_records = records.length;
    report.correlated_response_log_ids = client.logIds.size;
  };

  return {
    temporary,
    plugins,
    client,
    download,
    logs,
    start,
    shutdown,
    verifyLogs,
    assertRunning: () => assert.equal(child.exitCode, null, '热装卸期间宿主不得重启'),
    finish: async (fixtures) =>
      finishHost({ temporary, fixtures, child, closed, client, report, graceful, logs }),
  };
}

async function finishHost({ temporary, fixtures, child, closed, client, report, graceful, logs }) {
  const problems = [];
  if (child?.pid && child.exitCode === null && child.signalCode === null && !graceful) {
    try {
      await client.post('/api/v2/system/shutdown');
      report.failure_shutdown = await bounded(closed, 10000, '失败后自有宿主退出');
    } catch {
      problems.push('失败后的自有宿主未能正常关闭');
      // 只终止直接持有的 ChildProcess；不按可复用 PID 杀进程，也不将强制退出计为通过。
      if (child.exitCode === null && child.signalCode === null) child.kill();
      try {
        report.forced_shutdown = await bounded(closed, 3000, '强制关闭自有宿主');
      } catch {
        problems.push('自有宿主关闭事件仍未收敛');
      }
    }
  }
  report.fixture_processes = [];
  for (const item of fixtures) {
    const all = await events(item);
    for (const start of all.filter((event) => event.kind === 'started')) {
      const related = all.filter((event) => event.request_id === start.request_id);
      const visible = !exited(start.pid);
      report.fixture_processes.push({
        provider_id: item.id,
        protocol: item.protocol,
        request_id: start.request_id,
        pid: start.pid,
        label: start.label,
        process_visible: visible,
        events: related.map(({ kind, at, code }) => ({
          kind,
          at,
          ...(code === undefined ? {} : { code }),
        })),
      });
      if (visible) problems.push(`本次夹具 ${start.pid} 仍可见，不强杀`);
      if (related.some((event) => event.kind === 'fixture_error'))
        problems.push('夹具报告内部执行错误');
      const cancellation = related.some((event) => event.kind === 'cancel_received');
      const killedV2 = item.protocol === 2 && start.label.startsWith('cancel-');
      if (!killedV2) {
        for (const kind of ['cleaned', 'response_written', 'stdin_eof', 'process_exit']) {
          if (!related.some((event) => event.kind === kind)) problems.push(`夹具缺少 ${kind} 证据`);
        }
        if (!related.some((event) => event.kind === 'process_exit' && event.code === 0))
          problems.push('夹具没有零退出标记');
      }
      if (item.protocol === 3 && start.label.startsWith('cancel-') && !cancellation)
        problems.push('协议 3 未收到实际取消帧');
    }
  }
  if (!report.passed) {
    try {
      report.failure_log_events = (await logs())
        .filter((record) =>
          ['合作插件资源未确认清理', '插件调用结束', '任务执行失败', '宿主运行已结束'].includes(
            record.fields?.message,
          ),
        )
        .slice(-20)
        .map((record) => ({
          timestamp: record.timestamp,
          level: record.level,
          message: record.fields.message,
          code: record.fields.code,
        }));
    } catch {}
  }
  if (problems.length) {
    report.cleanup_error = [...new Set(problems)];
    report.passed = false;
    process.exitCode = 1;
  }
  // 失败证据一律保留；仅通过时清理本次已核对绝对范围的临时目录。
  if (report.passed && graceful && problems.length === 0) {
    const within = relative(resolve(tmpdir()), resolve(temporary));
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within), '本次临时目录不得越界');
    assert.ok(temporary.startsWith(join(tmpdir(), 'deviceforge-nested-artifacts-')));
    await rm(temporary, { recursive: true, force: true });
    report.temporary_removed = true;
    delete report.temporary_retained;
  }
}
