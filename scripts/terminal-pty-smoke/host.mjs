import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertListenerReleased, reservePort } from '../unified-discovery-smoke/host.mjs';
import { clientFor } from '../ordinary-deadline-http/client.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export { reservePort };
export function powershellArguments(directory) {
  const history = join(directory, 'powershell-history.txt').replaceAll("'", "''");
  // 在首次交互读取前指定本次历史路径，不读取或追加用户的PSReadLine命令历史。
  const initialize = "$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
    + `Set-PSReadLineOption -HistorySavePath '${history}' -HistorySaveStyle SaveNothing; `
    + "if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('PredictionSource')) { Set-PSReadLineOption -PredictionSource None }";
  return ['-NoLogo', '-NoProfile', '-NoExit', '-Command', initialize];
}
export async function prepareHost({ root, binary, directory, report, port }) {
  const plugins = join(directory, 'server-plugins'), browser = join(directory, 'browser-plugins');
  const user = join(directory, 'user', '.deviceforge');
  await Promise.all([plugins, browser, user].map((path) => mkdir(path, { recursive: true })));
  const base = `http://127.0.0.1:${port}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)));
  const identity = await fileIdentity(binary);
  const child = spawn(binary, [], { cwd: join(root, 'backend'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: directory, APK_PLUGIN_DIR: plugins,
      APK_BROWSER_PLUGIN_DIR: browser, APK_MCP_HOSTS: `127.0.0.1:${port}`, APK_MCP_ORIGINS: base,
      DEVICEFORGE_USER_DIR: user, DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000' } });
  const entry = { pid: child.pid, port, binary: identity, user_directory: user, data: directory, started_at: new Date().toISOString() };
  (report.hosts ??= []).push(entry);
  let stdout = '', stderr = '', spawnError, ended = false;
  child.stdout.on('data', (bytes) => { stdout = (stdout + bytes.toString()).slice(-32768); });
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-32768); });
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((done) => child.once('close', (code, signal) => {
    entry.exit = { code, signal, at: new Date().toISOString() }; done({ code, signal });
  }));
  const client = clientFor(base, report);
  async function exited() {
    let timer;
    const result = await Promise.race([closed, new Promise((done) => { timer = setTimeout(() => done({ timeout: true }), 10000); })]);
    clearTimeout(timer);
    assert.deepEqual(result, { code: 0, signal: null }, '独占宿主应正常退出0');
    await assertListenerReleased(port);
    report.listener = { host: '127.0.0.1', port, released: true };
    ended = true;
  }
  async function save() {
    await writeFile(join(directory, 'host.stdout.log'), stdout);
    await writeFile(join(directory, 'host.stderr.log'), stderr);
    entry.stdout_bytes = Buffer.byteLength(stdout); entry.stderr_bytes = Buffer.byteLength(stderr);
  }
  async function shutdown() {
    assert.equal(child.exitCode, null);
    await client.post('/api/v2/system/shutdown');
    await exited(); entry.graceful_shutdown = true;
    await save();
  }
  return { child, client, entry, plugins, browser, directory, user,
    async ready() {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) { await save(); throw new Error('独占宿主就绪前退出：' + stderr.trim().slice(-2000)); }
        try { if ((await client.json('/api/v2/health')).status === 'ok') break; } catch { /* 等待本次独占监听就绪。 */ }
        await delay(50);
      }
      assert.equal((await client.json('/api/v2/health')).status, 'ok');
      assert.deepEqual(await client.json('/api/v2/plugins'), []);
      assert.deepEqual(await client.json('/api/v2/jobs?limit=100'), []);
      delete report.failed_request; entry.ready_at = new Date().toISOString();
    }, shutdown,
    async verifyIdentity() { assert.equal((await fileIdentity(binary)).sha256, identity.sha256); },
    async finish() {
      let failure;
      try {
        if (!ended) {
          if (child.exitCode === null && child.signalCode === null) await shutdown();
          else await exited();
        }
      } catch (error) {
        failure = error;
        if (child.exitCode === null && child.signalCode === null) { child.kill(); entry.forced_direct_child_termination = true; await Promise.race([closed, delay(5000, undefined, { ref: false })]); }
        try { await assertListenerReleased(port); report.listener = { host: '127.0.0.1', port, released: true }; }
        catch { report.listener = { host: '127.0.0.1', port, released: false }; }
      }
      await save();
      if (failure) throw failure;
    },
  };
}
