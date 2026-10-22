// 仅管理本轮复制的宿主与端口；不连接现有预览，也不输出配置原值。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

async function bounded(pending, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((done) => {
        timer = setTimeout(() => done(null), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function port(selected = 0) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(selected, '127.0.0.1', done);
  });
  const value = server.address().port;
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return value;
}

export async function poll(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`等待超时：${label}`);
}

export async function launch(paths, report) {
  const selected = await port();
  const base = `http://127.0.0.1:${selected}`;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
  );
  const child = spawn(paths.binary, [], {
    cwd: paths.output,
    env: {
      ...environment,
      APK_BIND: `127.0.0.1:${selected}`,
      APK_DATA_DIR: paths.data,
      APK_PLUGIN_DIR: paths.deployment,
      APK_BROWSER_PLUGIN_DIR: paths.browserDeployment,
      DEVICEFORGE_USER_DIR: paths.user,
      DEVICEFORGE_HTTP_RATE: '10000',
    },
    windowsHide: true,
    stdio: 'ignore',
  });
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  );
  const entry = {
    round: report.hosts.length + 1,
    pid: child.pid,
    port: selected,
    data: paths.data,
  };
  report.hosts.push(entry);

  async function call(path, { method = 'GET', input, status = 200, timeout = 15000 } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.json();
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.ok(body.log_id === logId, '响应体与请求头日志 ID 必须一致');
    assert.ok(typeof logId === 'string' && /^[a-f0-9-]{36}$/.test(logId), '响应必须含有效日志 ID');
    report.requests.push({
      round: entry.round,
      method,
      path,
      status: response.status,
      log_id: logId,
      error: body.error?.code,
    });
    assert.ok(
      response.status === status,
      `${method} ${path}：期望 ${status}，实际 ${response.status}`,
    );
    return body.data ?? body.error;
  }

  async function stop() {
    const failures = [];
    let result = await bounded(closed, 1);
    if (!result) {
      try {
        await call('/api/v2/system/shutdown', { method: 'POST', timeout: 5000 });
      } catch {
        failures.push('公开关闭请求失败');
      }
      result = await bounded(closed, 12000);
    }
    if (!result) {
      entry.forced = true;
      child.kill();
      result = await bounded(closed, 5000);
      failures.push('宿主未在正常关闭期限内退出');
    }
    entry.exit = result;
    entry.exit_confirmed = result !== null;
    entry.normal_shutdown = result?.code === 0 && entry.forced !== true;
    try {
      await port(selected);
      entry.port_released = true;
    } catch {
      entry.port_released = false;
    }
    if (!entry.normal_shutdown) failures.push('宿主正常退出未确认');
    if (!entry.port_released) failures.push('宿主监听端口未释放');
    if (failures.length) {
      entry.cleanup_errors = failures;
      if (!result) child.unref();
      throw new Error(failures.join('；'));
    }
  }

  try {
    await poll(
      async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode) throw new Error('宿主就绪前退出');
        try {
          return (await call('/api/v2/health', { timeout: 1000 })).status === 'ok';
        } catch {
          return false;
        }
      },
      Boolean,
      '隔离宿主就绪',
      15000,
    );
    return { call, stop };
  } catch (error) {
    try {
      await stop();
    } catch {
      report.cleanup_errors.push('宿主就绪失败后的正常清理未通过');
    }
    throw error;
  }
}
