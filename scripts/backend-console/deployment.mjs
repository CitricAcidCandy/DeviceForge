// 默认只选择已经交付的预览部署，不替换二进制或搬迁既有数据。
import { join, resolve } from 'node:path';

export function defaultDeployment(root) {
  const directory = resolve(root, 'artifacts', 'device-workspace-preview-20261014');
  const dataDirectory = join(directory, 'data');
  return {
    directory,
    binary: join(directory, 'server-user-configurations-20261022.exe'),
    dataDirectory,
    pluginDirectory: join(directory, 'plugins'),
    browserPluginDirectory: join(directory, 'browser-plugins'),
    logDirectory: join(dataDirectory, 'logs'),
    port: 7031,
  };
}
