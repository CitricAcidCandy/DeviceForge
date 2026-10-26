// 宿主只从显式冻结二进制复制，使用本轮独占的用户根、插件根与端口。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { client } from './client.mjs';
import { identity, poll } from './evidence.mjs';
import { listenerOwners, ownedProcesses, reclaim } from './processes.mjs';
import { listenerReleased } from './source.mjs';

export function environment(root, port, source, envProgram, { bootstrapNode = true } = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(APK_|DEVICEFORGE_|DF_DEPENDENCY_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)
      && (bootstrapNode || !/^PATH$/i.test(key))));
  return { ...inherited, APK_BIND: `127.0.0.1:${port}`, APK_MCP_HOSTS: `127.0.0.1:${port}`,
    APK_MCP_ORIGINS: `http://127.0.0.1:${port}`, APK_DATA_DIR: join(root, 'data'),
    APK_PLUGIN_DIR: join(root, 'data/server-plugins'), APK_BROWSER_PLUGIN_DIR: join(root, 'data/browser-plugins'),
    DEVICEFORGE_USER_DIR: join(root, 'user/.deviceforge'),
    ...(bootstrapNode ? { DEVICEFORGE_NODE: process.execPath, DF_DEPENDENCY_NODE: envProgram }
      : { PATH: join(root, 'bootstrap-path') }),
    DEVICEFORGE_HTTP_RATE: '10000', DEVICEFORGE_MARKETPLACE_SOURCES: JSON.stringify([{ name: '隔离依赖源', url: source }]),
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export async function launchHost({ root, binaryDirectory, binaryPath, source, envProgram, report, signal, bootstrapNode = true }) {
  assert.equal(process.platform, 'win32', '当前夹具只证明 Windows 真实进程与依赖安装');
  const original = binaryPath ?? join(binaryDirectory, 'apk-server.exe'), binary = join(root, 'host/apk-server.exe');
  const inputIdentity = await identity(original);
  await mkdir(join(root, 'host'));
  await copyFile(original, binary);
  const copied = await identity(binary);
  assert.equal(copied.sha256, inputIdentity.sha256, '冻结 exe 复制期间不能发生变化');
  assert.deepEqual(await identity(original), inputIdentity, '冻结 exe 原输入必须在复制期间保持一致');
  report.frozen_binary = inputIdentity;
  const port = await reservePort();
  const env = environment(root, port, source, envProgram, { bootstrapNode });
  for (const path of [env.APK_DATA_DIR, env.APK_PLUGIN_DIR, env.APK_BROWSER_PLUGIN_DIR, join(root, 'responses')]) {
    await mkdir(path, { recursive: true });
  }
  if (!bootstrapNode) await mkdir(env.PATH);
  assert.deepEqual(await ownedProcesses(root), [], '启动前不得已有相同证据根的活动进程');
  signal?.throwIfAborted();
  const logs = ['stdout', 'stderr'].map((name) => createWriteStream(join(root, `host.${name}.log`), { flags: 'wx' }));
  const entry = { binary: copied, port, user_root: env.DEVICEFORGE_USER_DIR, started_at: new Date().toISOString(),
    bootstrap_node: bootstrapNode ? 'legacy_node_fixture_only' : 'absent',
    ...(!bootstrapNode ? { isolated_path: env.PATH, node_override_present: Object.hasOwn(env, 'DEVICEFORGE_NODE') } : {}) };
  report.hosts.push(entry);
  const child = spawn(binary, [], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  entry.pid = child.pid;
  child.stdout.pipe(logs[0]); child.stderr.pipe(logs[1]);
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((done) => child.once('close', (code, signal) => {
    entry.exit = { code, signal, at: new Date().toISOString() }; done(entry.exit);
  }));
  const api = client(`http://127.0.0.1:${port}`, join(root, 'responses'), report, signal);
  let finalized = false;
  async function stop() {
    if (finalized) return;
    let failure;
    try {
      if (child.exitCode === null && child.signalCode === null && !spawnError) {
        assert.deepEqual(await listenerOwners(port), [child.pid], '不向其他进程持有的端口发送 shutdown');
        const reply = await api.http('/api/v2/system/shutdown', { method: 'POST' });
        assert.equal(reply.stopping, true);
        entry.shutdown_requested = true;
      }
      const result = await Promise.race([closed, delay(12000, undefined, { ref: false })]);
      assert.ok(result, '宿主正常退出超时');
      assert.equal(result.code, 0); assert.equal(result.signal, null);
      entry.graceful = true;
    } catch (error) { failure = error; }
    try {
      const forced = await reclaim(root, report);
      entry.forced_reclamation = forced;
      if (forced && !failure) failure = new Error('宿主退出后仍有归属进程，不能计为正常通过');
      const result = await Promise.race([closed, delay(5000, undefined, { ref: false })]);
      assert.ok(result, '回收后未收到宿主退出事件');
      await Promise.all(logs.map((stream) => finished(stream, { signal: AbortSignal.timeout(5000) })));
      await listenerReleased(port); entry.listener_released = true;
      assert.equal((await identity(original)).sha256, inputIdentity.sha256, '冻结宿主原输入发生变化');
      assert.equal((await identity(binary)).sha256, copied.sha256, '宿主副本发生变化');
      finalized = true;
      report.reclamation.push({ pid: child.pid, command: binary, reclaimed: true, graceful: Boolean(entry.graceful), exit: entry.exit });
    } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
  try {
    await poll(async () => {
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('独占宿主就绪前退出，查看 host.stderr.log');
      try { return (await api.http('/api/v2/health')).status === 'ok'; } catch { return false; }
    }, Boolean, '独占宿主健康');
    assert.deepEqual(await listenerOwners(port), [child.pid], '就绪端口必须属于本轮实际启动的宿主');
    const owned = await ownedProcesses(root, report.hosts);
    entry.os_identity = owned.find((value) => value.ProcessId === child.pid);
    assert.ok(entry.os_identity, '必须核对本轮宿主 OS 身份');
    assert.deepEqual(await api.http('/api/v2/plugins'), []);
    assert.deepEqual(await api.http('/api/v2/jobs?limit=100'), []);
    return { api, stop, entry };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { report.start_cleanup_error = cleanupError.message; }
    throw error;
  }
}
