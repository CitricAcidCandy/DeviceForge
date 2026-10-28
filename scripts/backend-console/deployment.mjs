// 普通启动选择本仓库编译产物，沿用原有数据与插件，不搬迁部署。
import { join, resolve } from 'node:path';

export function defaultDeployment(root) {
  const directory = resolve(root, 'artifacts', 'device-workspace-preview-20261014');
  const dataDirectory = join(directory, 'data');
  return {
    directory,
    binary: resolve(root, 'backend', 'target', 'debug', 'apk-server.exe'),
    // 原停止入口仍可识别历史固定程序，升级时由使用者正常停止旧服务。
    previousBinary: join(directory, 'server-mirroring-release-20261023.exe'),
    dataDirectory,
    pluginDirectory: join(directory, 'plugins'),
    browserPluginDirectory: join(directory, 'browser-plugins'),
    logDirectory: join(dataDirectory, 'logs'),
    port: 7031,
  };
}
