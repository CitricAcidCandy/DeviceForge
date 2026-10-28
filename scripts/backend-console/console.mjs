import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogFollower } from './logs.mjs';
import { ensureServer, serverStatus, stopServer } from './server.mjs';

function showStatus(status, write) {
  if (!status.running) write('后端未运行。');
  else
    write(
      `后端${status.health ? '运行正常' : '进程仍在监听，健康检查未通过'}，进程 ID：${status.server.pid}。`,
    );
}

function showStopped(result, write) {
  if (!result.pid) write('后端未运行，无需停止。');
  else {
    write(`后端已停止${result.pid ? `，进程 ID：${result.pid}` : ''}。`);
    if (result.forced) write(`进程收尾说明：${result.reason}`);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

// 控制台只编排输入和日志，部署身份与停止边界由服务器模块负责。
export async function runBackendConsole(
  config,
  { mode = 'follow', input = process.stdin, write = console.log } = {},
) {
  if (mode === 'status') {
    showStatus(await serverStatus(config), write);
    return 0;
  }
  if (mode === 'stop') {
    write('正在核对后端进程并请求停止，请等待……');
    showStopped(await stopServer(config), write);
    return 0;
  }
  let action;
  let wake;
  const requested = new Promise((resolve) => {
    wake = resolve;
  });
  const request = (value) => {
    if (action) return;
    action = value;
    wake();
  };
  const interrupt = () => request('stop');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let reader;
  let follower;
  let server;
  let statusTask = Promise.resolve();
  try {
    write('正在检查并启动 DeviceForge 后端……');
    server = await ensureServer(config, { background: mode === 'background' });
    write(`${server.started ? '后端已启动' : '已连接运行中的后端'}，进程 ID：${server.pid}。`);
    write(`访问地址：http://127.0.0.1:${config.port}，局域网使用本机 IP。`);
    write(`MCP 地址：http://127.0.0.1:${config.port}/mcp，与 HTTP 共用同一后端进程和端口。`);
    write(`服务器日志：${config.logDirectory}`);
    if (mode === 'background' && !action) {
      write('后端在后台运行；使用 停止后端.bat 或 --stop 正常停止。');
      return 0;
    }
    write('输入 stop 回车或按 Ctrl+C 停止后端；quit 回车仅退出日志；status 回车查看状态。');
    follower = createLogFollower(config.logDirectory, { write, initialLines: 20 });
    reader = createInterface({ input, terminal: Boolean(input.isTTY) });
    reader.on('SIGINT', interrupt);
    reader.on('close', () => request('quit'));
    let statusBusy = false;
    reader.on('line', (line) => {
      const command = line.trim().toLowerCase();
      if (command === 'stop') request('stop');
      else if (command === 'quit') request('quit');
      else if (command === 'status') {
        if (action || statusBusy) return;
        statusBusy = true;
        statusTask = serverStatus(config)
          .then((status) => showStatus(status, write))
          .catch((error) => write(`状态检查失败：${error.message}`))
          .finally(() => {
            statusBusy = false;
          });
      } else if (command) write('可用命令：stop、quit、status，输入后按回车。');
    });
    while (!action) {
      await follower.poll();
      if (!alive(server.pid)) {
        write('后端进程已退出，日志查看结束。');
        return 0;
      }
      await Promise.race([requested, delay(300)]);
    }
    await statusTask;
    if (action === 'stop') {
      write('正在正常停止后端，请等待任务和日志收尾……');
      showStopped(await stopServer(config, server), write);
      await follower.poll();
    } else write('已退出日志查看，后端继续运行；可用 停止后端.bat 停止。');
    return 0;
  } catch (error) {
    if (server) write('控制台已退出；请用 --status 核对后端，使用 --stop 明确停止。');
    throw error;
  } finally {
    reader?.close();
    input.pause();
    await statusTask;
    await follower?.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
