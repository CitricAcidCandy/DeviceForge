// 每例隔离用户根与日志，只回收本轮直接创建的宿主。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttp } from './http.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { assertListenerReleased, reservePort } from '../unified-discovery-smoke/host.mjs';
import { poll } from '../device-provider/client.mjs';

export { reservePort };

export async function prepareHost({ binary, directory, report, port }) {
  assert.ok(![7031, 5173].includes(port));
  const plugins = join(directory, 'server-plugins');
  const browser = join(directory, 'browser-plugins');
  const user = join(directory, 'user');
  for (const path of [plugins, browser, user]) await mkdir(path, { recursive: true });
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)));
  Object.assign(env, {
    APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: directory,
    APK_PLUGIN_DIR: plugins, APK_BROWSER_PLUGIN_DIR: browser,
    APK_MCP_HOSTS: `127.0.0.1:${port}`, APK_MCP_ORIGINS: base,
    DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000',
    DEVICEFORGE_USER_DIR: user,
  });
  const entry = { ordinal: 1, binary: await fileIdentity(binary),
    started_at: new Date().toISOString(), port, user_directory: user,
    stdout: join(directory, 'host.stdout.log'), stderr: join(directory, 'host.stderr.log') };
  let out, err, child;
  try {
    out = openSync(entry.stdout, 'wx');
    err = openSync(entry.stderr, 'wx');
    child = spawn(binary, [], { cwd: directory, env,
      stdio: ['ignore', out, err], windowsHide: true });
  } finally {
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
  }
  report.hosts ??= [];
  report.hosts.push(entry);
  entry.pid = child.pid;
  let spawnError, ended = false;
  child.on('error', (error) => { spawnError = error; });
  const closed = new Promise((done) => child.once('close', (code, signal) => {
    entry.exit = { code, signal, observed_at: new Date().toISOString() };
    done({ code, signal });
  }));
  const client = createHttp(base, report);
  const release = async () => {
    await assertListenerReleased(port);
    report.listener = { port, released: true };
  };
  const verifyExit = () => {
    assert.deepEqual({ code: child.exitCode, signal: child.signalCode }, { code: 0, signal: null });
    assert.equal(entry.forced_direct_child_termination, undefined);
    assert.equal(entry.graceful_shutdown, true);
  };
  const shutdown = async () => {
    const before = Date.now();
    assert.equal(child.exitCode, null);
    await client.post('/api/v2/system/shutdown', undefined, { signal: AbortSignal.timeout(10000) });
    const result = await Promise.race([closed,
      delay(Math.max(0, 10000 - (Date.now() - before))).then(() => ({ timeout: true }))]);
    assert.deepEqual(result, { code: 0, signal: null });
    entry.graceful_shutdown = true;
    entry.shutdown_elapsed_ms = Date.now() - before;
    verifyExit();
    await release();
    ended = true;
  };
  return {
    child, closed, client, entry, plugins, browser, directory, shutdown,
    ready: async () => {
      await poll(async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error('本轮隔离宿主启动失败，请核对其独立stderr');
        try { return (await client.json('/api/v2/health')).status === 'ok'; }
        catch { return false; }
      }, Boolean, '隔离用户根宿主就绪');
      delete report.failed_request;
      entry.ready_at = new Date().toISOString();
      assert.deepEqual(await client.json('/api/v2/plugins'), []);
      assert.deepEqual(await client.json('/api/v2/jobs?limit=100'), []);
    },
    finish: async () => {
      if (ended) return;
      let failure;
      try {
        if (child.exitCode === null && child.signalCode === null) await shutdown();
        else { await closed; verifyExit(); }
      } catch (error) { failure = error; }
      if (child.exitCode === null && child.signalCode === null) {
        entry.forced_direct_child_termination = true;
        child.kill();
        const result = await Promise.race([closed, delay(5000).then(() => ({ timeout: true }))]);
        assert.ok(!result.timeout, '本轮直接宿主仍未退出');
      }
      await release();
      if (failure) throw failure;
      ended = true;
    },
    verifyIdentity: async () => {
      const actual = await fileIdentity(binary);
      assert.equal(actual.sha256, entry.binary.sha256);
      assert.equal(actual.bytes, entry.binary.bytes);
      report.host_identity_after = actual;
    },
  };
}
