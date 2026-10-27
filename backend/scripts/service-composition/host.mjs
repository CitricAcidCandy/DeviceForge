import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { poll, sha256 } from './common.mjs';

async function freePort(port = 0) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  const selected = server.address().port;
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return selected;
}

export async function createHost(context) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const executable = join(context.evidence, 'bin', `apk-server${process.platform === 'win32' ? '.exe' : ''}`);
  await mkdir(join(context.evidence, 'bin'));
  await copyFile(context.binary('apk-server'), executable);
  assert.equal(sha256(await readFile(executable)), context.report.inputs.find((item) => item.name === 'apk-server').sha256);
  // 每轮使用新路径与新数据根，既不复用用户服务，也不会出现相同命令行的第二份宿主。
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(APK_|DEVICEFORGE_|CARGO_)/i.test(key) && !/(TOKEN|PASSWORD|SECRET|API_KEY)/i.test(key)));
  const child = spawn(executable, [], { cwd: context.backend, windowsHide: true, stdio: 'ignore', env: {
    ...environment, APK_BIND: `127.0.0.1:${port}`, APK_API_TOKEN: context.token,
    APK_DATA_DIR: join(context.evidence, 'data'), APK_PLUGIN_DIR: context.plugins,
    DEVICEFORGE_USER_DIR: join(context.evidence, 'user'), DEVICEFORGE_HTTP_RATE: '10000',
  } });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  context.report.host = { pid: child.pid, executable, port, command: [executable], spawned: Boolean(child.pid) };
  let owned = false;
  async function ready() {
    await poll(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('隔离宿主在就绪前退出');
      try {
        // 未鉴权必须拒绝，防止端口竞争时误把用户的免鉴权服务当成本轮宿主。
        const denied = await fetch(`${base}/api/v2/health`, { signal: AbortSignal.timeout(500) });
        if (denied.status !== 401) return false;
        const health = await fetch(`${base}/api/v2/health`, {
          headers: { authorization: `Bearer ${context.token}` }, signal: AbortSignal.timeout(500),
        });
        return health.status === 200;
      } catch { return false; }
    }, Boolean, '隔离宿主就绪', 15000);
    owned = true;
    context.report.host.identity_verified = true;
  }
  async function stop() {
    if (child.pid && child.exitCode === null && child.signalCode === null && owned) {
      try {
        await fetch(`${base}/api/v2/system/shutdown`, { method: 'POST',
          headers: { authorization: `Bearer ${context.token}` }, signal: AbortSignal.timeout(3000) });
      } catch { context.report.host.shutdown_request_failed = true; }
    }
    let ending = await Promise.race([closed, delay(10000, { timeout: true }, { ref: false })]);
    if (ending.timeout && child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill();
      context.report.host.forced = true;
      ending = await Promise.race([closed, delay(5000, { timeout: true }, { ref: false })]);
    }
    Object.assign(context.report.host, { exit: ending, process_exited: !ending.timeout,
      graceful: !ending.timeout && ending.code === 0 && !context.report.host.forced });
    try { await freePort(port); context.report.host.port_released = true; }
    catch { context.report.host.port_released = false; }
    assert.equal(context.report.host.process_exited, true, '本轮宿主未退出');
    assert.equal(context.report.host.port_released, true, '本轮端口未释放');
    assert.equal(context.report.host.graceful, true, '强制终止不能冒充正常退出');
  }
  return { base, ready, stop };
}
