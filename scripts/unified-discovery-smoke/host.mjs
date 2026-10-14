import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { poll } from '../device-provider/client.mjs';
import { clientFor, fileIdentity } from './evidence.mjs';

export async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}

export async function assertListenerReleased(port) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
}

// 编排只使用主代理已构建的宿主；重启沿用同一部署、SQLite和日志目录。
export async function startHost({
  root,
  binary,
  directory,
  bindingsPath,
  report,
  port,
  ordinal,
  performancePlugin,
}) {
  const plugins = join(directory, 'server-plugins'),
    browser = join(directory, 'browser-plugins');
  await mkdir(plugins, { recursive: true });
  await mkdir(browser, { recursive: true });
  const base = `http://127.0.0.1:${port}`;
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
  );
  const env = {
    ...inherited,
    APK_BIND: `127.0.0.1:${port}`,
    APK_DATA_DIR: directory,
    APK_PLUGIN_DIR: plugins,
    APK_BROWSER_PLUGIN_DIR: browser,
    APK_MCP_HOSTS: `127.0.0.1:${port}`,
    APK_MCP_ORIGINS: base,
    DEVICEFORGE_NODE: process.execPath,
    DEVICEFORGE_HTTP_RATE: '10000',
    ...(bindingsPath ? { APK_OPERATION_BINDINGS: bindingsPath } : {}),
    ...(performancePlugin === undefined ? {} : { APK_PERFORMANCE_PLUGIN: performancePlugin }),
  };
  if (performancePlugin !== undefined)
    assert.match(performancePlugin, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
  const identity = await fileIdentity(binary);
  const entry = {
    ordinal,
    binary: identity,
    started_at: new Date().toISOString(),
    default_authentication: '无token',
    node: { executable: process.execPath, version: process.version },
    port,
  };
  report.hosts ??= [];
  report.hosts.push(entry);
  const child = spawn(binary, [], {
    cwd: join(root, 'backend'),
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  entry.pid = child.pid;
  const closed = new Promise((done) =>
    child.once('close', (code, signal) => {
      entry.exit = { code, signal, observed_at: new Date().toISOString() };
      done({ code, signal });
    }),
  );
  const client = clientFor(base, report);
  const host = { child, closed, client, entry, plugins, browser, directory };
  // 先把实际句柄登记到调用方，避免就绪阶段失败后丢失自有宿主。
  report.active_host_ordinal = ordinal;
  return {
    ...host,
    ready: async () => {
      await poll(
        async () => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error('统一发现宿主就绪前退出');
          try {
            await client.json('/api/v2/health');
            return true;
          } catch {
            return false;
          }
        },
        Boolean,
        '统一发现宿主就绪',
      );
      // 就绪轮询的连接拒绝属于启动观测，业务开始前清掉暂存诊断。
      delete report.failed_request;
      entry.ready_at = new Date().toISOString();
    },
  };
}

export async function stopHost(host) {
  const started = Date.now();
  if (host.child.exitCode !== null || host.child.signalCode !== null) {
    assert.fail('正常shutdown前宿主已退出');
  }
  await host.client.post('/api/v2/system/shutdown', undefined, {
    signal: AbortSignal.timeout(10000),
  });
  const remaining = Math.max(0, 10000 - (Date.now() - started));
  const ended = await Promise.race([host.closed, delay(remaining).then(() => ({ timeout: true }))]);
  assert.deepEqual(ended, { code: 0, signal: null }, '宿主必须在原10秒退出期限内正常退出');
  host.entry.graceful_shutdown = true;
  host.entry.shutdown_elapsed_ms = Date.now() - started;
}

export async function finishOwnHost(host) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) {
    await host.closed;
    return;
  }
  let shutdownError;
  try {
    await stopHost(host);
  } catch (error) {
    shutdownError = error;
  }
  if (host.child.exitCode === null && host.child.signalCode === null) {
    // 只操作spawn返回的本次直接子进程；不扫描、不终止任何夹具或未知PID。
    host.entry.forced_direct_child_termination = true;
    host.child.kill();
  }
  const ended = await Promise.race([host.closed, delay(5000).then(() => ({ timeout: true }))]);
  assert.ok(!ended.timeout, '本次直接宿主仍未退出，必须保留全部临时证据');
  if (shutdownError) throw shutdownError;
}
