// 生命周期只接管精确 Win32 身份；不执行设备工具，不终止其他进程树。
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readRecentRecords } from './logs.mjs';
import {
  ownedListener,
  processSnapshot,
  sameBinary,
  sameIdentity,
  terminateIdentity,
} from './identities.mjs';

export async function waitUntil(read, accept, timeout = 10000) {
  const until = Date.now() + timeout;
  do {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= until) break;
    await delay(150);
  } while (Date.now() < until);
  throw Object.assign(new Error('等待服务器状态收敛超时'), { code: 'SERVER_WAIT_TIMEOUT' });
}

function checked(config) {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error('服务器端口无效');
  for (const key of [
    'directory',
    'binary',
    'dataDirectory',
    'pluginDirectory',
    'browserPluginDirectory',
    'logDirectory',
  ]) {
    if (typeof config[key] !== 'string' || resolve(config[key]) !== config[key])
      throw new Error('服务器部署路径必须为绝对路径');
  }
}

async function health(config) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/v2/health`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return body.data?.status === 'ok' ? body.data : undefined;
  } catch {
    return undefined;
  }
}

export async function getServerIdentity(config) {
  checked(config);
  return ownedListener(config, await processSnapshot(config.port));
}

export async function serverStatus(config) {
  const server = await getServerIdentity(config);
  if (!server) return { running: false };
  const ready = await health(config);
  const current = await getServerIdentity(config);
  if (!sameIdentity(server, current)) throw new Error('健康检查期间服务器身份发生变化');
  return { running: true, server, ...(ready ? { health: ready } : {}) };
}

function environment(config) {
  // 保留部署者现有工具配置，只覆盖原启动脚本明确负责的实例参数。
  return {
    ...process.env,
    APK_BIND: config.bind ?? `0.0.0.0:${config.port}`,
    APK_DATA_DIR: config.dataDirectory,
    APK_PLUGIN_DIR: config.pluginDirectory,
    APK_BROWSER_PLUGIN_DIR: config.browserPluginDirectory,
    APK_PERFORMANCE_PLUGIN: 'android-device',
    APK_API_TOKEN: '',
    DEVICEFORGE_NODE: process.execPath,
    DEVICEFORGE_HTTP_RATE: '10000',
    DEVICEFORGE_LOG_DIR: config.logDirectory,
  };
}

function spawnServer(config, stdoutPath, stderrPath) {
  let output, errors;
  try {
    output = openSync(stdoutPath, 'wx');
    errors = openSync(stderrPath, 'wx');
    return spawn(config.binary, [], {
      cwd: config.directory,
      env: environment(config),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output, errors],
    });
  } finally {
    if (output !== undefined) closeSync(output);
    if (errors !== undefined) closeSync(errors);
  }
}

export async function ensureServer(config, { background = false } = {}) {
  checked(config);
  if (typeof background !== 'boolean') throw new Error('后台启动选项必须为布尔值');
  const current = await serverStatus(config);
  if (current.running) {
    if (!current.health) throw new Error('同一服务器进程已监听但健康检查失败，请先查看日志');
    return { ...current.server, started: false, stdoutPath: null, stderrPath: null };
  }
  const metadata = await lstat(config.binary);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('服务器程序必须是普通文件');
  await mkdir(config.logDirectory, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const stdoutPath = join(config.directory, `server-${stamp}.stdout.log`);
  const stderrPath = join(config.directory, `server-${stamp}.stderr.log`);
  const child = spawnServer(config, stdoutPath, stderrPath);
  let spawnError, identity;
  child.on('error', (error) => {
    spawnError = error;
  });
  // 前台界面与后台模式均不靠子进程句柄阻止 Node 退出，退出由明确菜单动作控制。
  child.unref();
  try {
    await waitUntil(
      async () => {
        if (spawnError || child.exitCode !== null || child.signalCode)
          throw new Error('本轮服务器启动失败，请查看 stderr 日志');
        const snapshot = await processSnapshot(config.port, child.pid);
        if (snapshot.target) {
          if (!sameBinary(snapshot.target.binary, config.binary))
            throw new Error('本轮启动 PID 对应的程序身份异常');
          identity ??= snapshot.target;
        }
        const listener = ownedListener(config, snapshot);
        if (listener && listener.pid !== child.pid)
          throw new Error('启动时端口被其他服务器进程占用');
        return listener && sameIdentity(listener, identity) && (await health(config));
      },
      Boolean,
      15000,
    );
    return { ...identity, started: true, stdoutPath, stderrPath };
  } catch (error) {
    // 启动失败只收尾本轮创建且仍匹配的 PID；绝不按端口或程序名批量结束。
    if (identity) {
      const snapshot = await processSnapshot(config.port, child.pid);
      if (sameIdentity(identity, snapshot.target)) await terminateIdentity(identity);
    } else if (!spawnError && child.pid && child.exitCode === null && !child.signalCode) {
      // Win32 查询尚未取得身份时，Node 仍持有本轮直接子进程句柄，可据此安全收口。
      child.kill();
    }
    if (!spawnError && child.pid)
      await waitUntil(() => child.exitCode !== null || Boolean(child.signalCode), Boolean, 5000);
    throw new Error(`${error.message}；本次启动错误日志：${stderrPath}`, { cause: error });
  }
}

async function completedShutdown(config, server, after) {
  const records = await readRecentRecords(config.logDirectory, 400);
  return records.some(
    (record) =>
      Date.parse(record.timestamp) >= after &&
      Date.parse(record.timestamp) >= Date.parse(server.startTime) &&
      record.fields?.message === '宿主运行已结束' &&
      record.fields.success === true,
  );
}

export async function stopServer(config, server) {
  checked(config);
  const snapshot = await processSnapshot(config.port, server?.pid ?? 0);
  const listener = ownedListener(config, snapshot);
  const selected = server ?? listener;
  if (!selected) return { stopped: true, forced: false, reason: '服务器未运行' };
  if (!sameBinary(selected.binary, config.binary))
    throw new Error('待停止进程不属于当前服务器部署');
  if (listener && !sameIdentity(selected, listener))
    throw new Error('服务器身份与待停止进程不一致');
  const initial = await processSnapshot(config.port, selected.pid);
  if (!initial.target) {
    if (initial.listeners.length) throw new Error('旧进程已退出，但端口已被其他进程占用');
    return { stopped: true, pid: selected.pid, forced: false, reason: '原进程已退出' };
  }
  if (!sameIdentity(selected, initial.target)) throw new Error('待停止 PID 已被其他进程复用');
  const before = Date.now();
  if (listener) {
    if (!(await health(config)))
      throw new Error('停止前健康检查未通过，不能向未知状态服务发送关闭请求');
    const verified = await getServerIdentity(config);
    if (!sameIdentity(selected, verified)) throw new Error('关闭请求前服务器身份发生变化');
    const response = await fetch(`http://127.0.0.1:${config.port}/api/v2/system/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('服务器拒绝关闭请求');
  }
  try {
    await waitUntil(async () => {
      const current = await processSnapshot(config.port, selected.pid);
      if (current.target && !sameIdentity(selected, current.target))
        throw new Error('关闭等待期间 PID 身份变化');
      if (current.listeners.some((item) => !sameIdentity(selected, item)))
        throw new Error('关闭等待期间端口被其他进程占用');
      return !current.target && current.listeners.length === 0;
    }, Boolean);
    return {
      stopped: true,
      pid: selected.pid,
      forced: false,
      reason: '服务器已正常退出，端口已释放',
    };
  } catch (error) {
    if (error.code !== 'SERVER_WAIT_TIMEOUT') throw error;
    const current = await processSnapshot(config.port, selected.pid);
    const ended = await completedShutdown(
      config,
      selected,
      listener ? before : Date.parse(selected.startTime),
    );
    if (
      !ended ||
      !sameIdentity(selected, current.target) ||
      current.children.some((child) => !child.systemConsole) ||
      current.listeningPorts.length ||
      current.listeners.length
    )
      throw error;
    await terminateIdentity(selected);
    await waitUntil(
      async () => {
        const last = await processSnapshot(config.port, selected.pid);
        return !last.target && last.listeners.length === 0;
      },
      Boolean,
      5000,
    );
    return {
      stopped: true,
      pid: selected.pid,
      forced: true,
      reason:
        '宿主已记录成功结束且无业务子进程或监听，仅结束残留的同身份 PID；原进程已退出，端口已释放',
    };
  }
}
