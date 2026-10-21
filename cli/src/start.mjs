import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRuntime } from './runtime.mjs';
import { spawnManaged, stopManaged } from './processes.mjs';
import { startWebServer } from './web-server.mjs';
import { networkConfig } from './network.mjs';
import { readApiToken, readMarketplaceConfig } from './options.mjs';
import { initializeRootConfiguration } from './root-config.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function ready(process, port, headers, signal) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (process.failure || process.child.exitCode !== null || process.child.signalCode)
      throw new Error('后端在就绪前退出，请检查部署配置');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers,
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await delay(50, undefined, { signal });
  }
  throw new Error('后端未在 15 秒内就绪');
}

// 生命周期与 HTTP 代理分开；启动任一步失败都只清理本次创建的进程和监听。
export async function start(
  options,
  { signal, environment = process.env, runtime, onReady = console.log } = {},
) {
  signal?.throwIfAborted();
  const token = readApiToken(environment);
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const marketplaceSources = options.marketplaceSources ?? readMarketplaceConfig();
  const resources = runtime || (await loadRuntime());
  const network = networkConfig(options.ip, options.port, options.mcpPort);
  await mkdir(options.dataDirectory, { recursive: true });
  const configurationPath = await initializeRootConfiguration(options.dataDirectory);
  // 相对部署路径始终按启动器工作目录解析，不能随 Rust 的数据目录工作目录改变。
  const pluginDirectory = resolve(
    environment.APK_PLUGIN_DIR || join(options.dataDirectory, 'plugins'),
  );
  await mkdir(pluginDirectory, { recursive: true });
  const browserPluginDirectory = resolve(
    environment.APK_BROWSER_PLUGIN_DIR || join(options.dataDirectory, 'browser-plugins'),
  );
  await mkdir(browserPluginDirectory, { recursive: true });
  const backendPort = await freePort();
  const logDirectory = resolve(
    environment.DEVICEFORGE_LOG_DIR || join(options.dataDirectory, 'logs'),
  );
  // 部署绑定同样相对启动器工作目录解析，不能随后端切换到数据目录。
  const bindings = environment.APK_OPERATION_BINDINGS;
  const bindingEnvironment =
    bindings === undefined ? {} : { APK_OPERATION_BINDINGS: bindings ? resolve(bindings) : '' };
  let web;
  let mcp;
  let backend;
  const stopped = new Promise((resolve) =>
    signal?.addEventListener('abort', resolve, { once: true }),
  );
  try {
    web = await startWebServer({
      port: options.port,
      backendPort,
      web: resources.web,
      ip: options.ip,
      allowedHosts: network.hosts,
    });
    mcp = await startWebServer({
      port: options.mcpPort,
      backendPort,
      ip: options.ip,
      allowedHosts: network.hosts,
      mcpOnly: true,
    });
    backend = spawnManaged(resources.binary, [], {
      cwd: options.dataDirectory,
      stdio: 'ignore',
      env: {
        ...environment,
        ...bindingEnvironment,
        APK_API_TOKEN: token,
        APK_BIND: `127.0.0.1:${backendPort}`,
        APK_DATA_DIR: options.dataDirectory,
        APK_PLUGIN_DIR: pluginDirectory,
        APK_BROWSER_PLUGIN_DIR: browserPluginDirectory,
        DEVICEFORGE_NODE: environment.DEVICEFORGE_NODE
          ? resolve(environment.DEVICEFORGE_NODE)
          : process.execPath,
        APK_MCP_HOSTS: `127.0.0.1:${backendPort}`,
        APK_MCP_ORIGINS: network.origins.join(','),
        DEVICEFORGE_LOG_DIR: logDirectory,
        DEVICEFORGE_MARKETPLACE_SOURCES: JSON.stringify(marketplaceSources),
        ...(options.marketplaceConfigPath
          ? { DEVICEFORGE_MARKETPLACE_CONFIG: options.marketplaceConfigPath }
          : {}),
      },
    });
    await ready(backend, backendPort, headers, signal);
    onReady(
      `DeviceForge 已启动，监听 ${options.ip}，前端/API ${options.port}，MCP ${options.mcpPort}；按 Ctrl+C 退出\n${network.urls.map((url) => `前端：${url.web}；MCP：${url.mcp}`).join('\n')}\n数据：${options.dataDirectory}\n根配置：${configurationPath}\n市场来源：${marketplaceSources.map((source) => source.url).join('，')}（资源服务需独立启动）\n日志：${logDirectory}`,
    );
    const result = await Promise.race([stopped.then(() => null), backend.closed]);
    if (result && (result.failure || result.code !== 0))
      throw new Error('后端异常退出，前端监听已停止');
  } finally {
    if (backend && backend.child.exitCode === null && !backend.child.signalCode) {
      try {
        await fetch(`http://127.0.0.1:${backendPort}/api/v2/system/shutdown`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(1500),
        });
        let timer;
        try {
          await Promise.race([
            backend.closed,
            new Promise((resolve) => {
              timer = setTimeout(resolve, 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch {}
    }
    await web?.close();
    await mcp?.close();
    await stopManaged(backend);
  }
}
