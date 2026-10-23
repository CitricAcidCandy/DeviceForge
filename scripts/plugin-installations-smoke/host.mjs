// 验收进程使用独占用户目录、业务根与端口，禁止连接现有预览。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function fileIdentity(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes);
    size += bytes.length;
  }
  return { path, size, sha256: hash.digest('hex') };
}

export async function port() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const selected = server.address().port;
  await new Promise((done) => server.close(done));
  return selected;
}
export async function poll(read, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(30);
  }
  throw new Error(`统一安装等待超时：${label}`);
}
export async function launch({
  binary,
  cwd,
  data,
  user,
  market,
  report,
  argumentsForPort = () => [],
  environment = {},
  readyTimeout = 15000,
  bindAddress = '127.0.0.1',
}) {
  const identity = await fileIdentity(binary);
  const selected = await port(),
    base = `http://127.0.0.1:${selected}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
  );
  const child = spawn(binary, argumentsForPort(selected), {
    cwd,
    env: {
      ...env,
      APK_BIND: `${bindAddress}:${selected}`,
      APK_MCP_HOSTS: `127.0.0.1:${selected}`,
      APK_MCP_ORIGINS: base,
      APK_DATA_DIR: data,
      APK_PLUGIN_DIR: `${data}/plugins`,
      APK_BROWSER_PLUGIN_DIR: `${data}/browser-plugins`,
      DEVICEFORGE_USER_DIR: user,
      DEVICEFORGE_NODE: process.execPath,
      DEVICEFORGE_MARKETPLACE_SOURCES: JSON.stringify([{ name: '隔离市场', url: market }]),
      DEVICEFORGE_HTTP_RATE: '10000',
      ...environment,
    },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-12000);
  });
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  );
  const entry = {
    pid: child.pid,
    binary: identity,
    port: selected,
    bind_address: bindAddress,
    data,
    user,
  };
  report.hosts.push(entry);
  async function call(path, { method = 'GET', input, status = 200, headers = {}, body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ?? (input === undefined ? undefined : JSON.stringify(input)),
      ...(body?.pipe ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const parsed = await response.json(),
      logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, /^[a-f0-9-]{36}$/);
    assert.equal(parsed.log_id, logId);
    report.requests.push({
      method,
      path,
      status: response.status,
      log_id: logId,
      code: parsed.error?.code,
    });
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(parsed.error)}`);
    return parsed.data ?? parsed.error;
  }
  async function stop() {
    let timer, outcome, failure;
    try {
      if (child.exitCode === null) await call('/api/v2/system/shutdown', { method: 'POST' });
      outcome = await Promise.race([
        closed,
        new Promise((done) => {
          timer = setTimeout(() => done(null), 15000);
        }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      if (!outcome && child.exitCode === null) {
        child.kill();
        entry.forced = true;
      }
      entry.exit = await closed;
    }
    if (failure) throw failure;
    assert.equal(entry.forced, undefined, '宿主必须正常退出');
    assert.equal(entry.exit.code, 0);
  }
  try {
    await poll(
      async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(stderr);
        try {
          await call('/api/v2/health');
          return true;
        } catch {
          return false;
        }
      },
      Boolean,
      '宿主健康',
      readyTimeout,
    );
  } catch (error) {
    if (child.exitCode === null) {
      child.kill();
      await closed;
    }
    throw error;
  }
  async function job(
    path,
    input,
    { success = true, method = 'POST', headers = {}, timeout = 15000 } = {},
  ) {
    const submitted = await call(path, { method, input, status: 202, headers });
    const result = await poll(
      () => call(`/api/v2/jobs/${submitted.id}`),
      (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
      '安装任务',
      timeout,
    );
    assert.equal(result.status, success ? 'succeeded' : 'failed', result.error ?? '任务状态');
    return result;
  }
  async function crash() {
    assert.equal(child.exitCode, null, '仅中断本轮尚在运行的宿主');
    child.kill();
    entry.crashed = true;
    entry.exit = await closed;
    return entry.exit;
  }
  return { base, call, job, stop, crash };
}
