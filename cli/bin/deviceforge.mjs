#!/usr/bin/env node
import { parseOptions, help } from '../src/options.mjs';
import { start } from '../src/start.mjs';
import { installPlugin, listPlugins } from '../src/install.mjs';
import {
  readRootConfiguration,
  rootConfigurationPath,
  importRootConfiguration,
} from '../src/root-config.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === 'help') console.log(help);
  else if (options.command === 'start') await start(options, { signal: controller.signal });
  else if (options.command === 'config.path')
    console.log(rootConfigurationPath(options.dataDirectory));
  else if (options.command === 'config.show')
    console.log(JSON.stringify(readRootConfiguration(options.dataDirectory), null, 2));
  else if (options.command === 'config.import') {
    const path = await importRootConfiguration(options.dataDirectory, options.source);
    console.log(`根配置已导入：${path}；下次启动生效，已安装内容和业务配置保留`);
  } else if (options.command === 'plugin.install') {
    const installed = await installPlugin(options, { signal: controller.signal });
    console.log(
      `插件 ${installed.id}@${installed.version} 安装完成，贡献 ${installed.operations} 项操作；${installed.metadata_complete ? '市场元数据完整' : '缺少 market.json，目录将标记为元数据不完整'}；重启服务加载`,
    );
  } else console.log(JSON.stringify(await listPlugins(options), null, 2));
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(`DeviceForge：${error.message}`);
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
