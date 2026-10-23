import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { readRootConfiguration } from './root-config.mjs';
import {
  DEFAULT_MARKETPLACE_URL,
  readMarketplaceConfig,
  validateMarketplaceUrl,
} from './marketplace.mjs';
export {
  DEFAULT_MARKETPLACE_URL,
  readMarketplaceConfig,
  validateMarketplaceUrl,
} from './marketplace.mjs';

export const help = `DeviceForge · 设备工坊
用法：deviceforge start [--ip 0.0.0.0] [--port 7030] [--mcp-port 7032] [--data-dir 目录] [--marketplace-url 地址 | --marketplace-config 文件]
      deviceforge plugin install <release.json完整URL|离线ZIP> [--api-url 服务地址] [--release-id ID --release-version 版本 --manifest-sha256 摘要]
      deviceforge plugin update <发布ID> <release.json完整URL|离线ZIP> --expected-revision 旧修订 [--api-url 服务地址]
      deviceforge plugin list [--api-url 服务地址]
      deviceforge plugin cleanup [--dry-run true|false] [--api-url 服务地址]
      deviceforge plugin install-legacy <本地目录|npm包名|本地tgz> [--data-dir 目录]
      deviceforge plugin list-legacy [--data-dir 目录]
      deviceforge config show [--data-dir 目录]
      deviceforge config path [--data-dir 目录]
      deviceforge config import <本地JSON> [--data-dir 目录]
      deviceforge --help

start 默认监听所有 IPv4 网卡，提供局域网前端/API 和独立 MCP 端口。
本地和局域网默认免鉴权；可选 APK_API_TOKEN 配置后不得包含空白。
不自动生成随机令牌；配置的令牌不打印、也不写入前端资源。
数据默认保存在用户目录 .deviceforge，可用 DEVICEFORGE_DATA_DIR 配置。
根配置为数据目录下 config.json；启动时读取，命令行只覆盖本次运行。
config import 校验后原子替换根配置；不会导入令牌或业务/插件配置。
资源服务独立启动；市场默认地址为 ${DEFAULT_MARKETPLACE_URL}。
--marketplace-url 指定市场地址；--marketplace-config 指定包含 sources 的 JSON 来源清单，两者互斥。
统一安装使用当前运行服务的用户目录；URL 安装须同时提供 ID、版本、SHA-256，必要输入不足时须先配置。
--api-url 默认 http://127.0.0.1:7030，或 DEVICEFORGE_API_URL；不会启动另一个后端。
Ctrl+C 结束客户端等待，已提交的服务器任务可在任务页面继续查看。
cleanup 默认只预览；--dry-run false 才由服务器清理未被引用的资源。
install-legacy/list-legacy 保留旧离线部署兼容入口，不处理依赖工具或统一安装记录。
`;

// 空字符串代表免鉴权；参数检查和直接启动共用同一可选令牌规则。
export function readApiToken(environment = process.env) {
  const token = environment.APK_API_TOKEN ?? '';
  if (typeof token !== 'string' || /\s/.test(token))
    throw new Error('APK_API_TOKEN 配置后不得包含空白');
  return token;
}

export function parseOptions(args, environment = process.env) {
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) return { command: 'help' };
  const command =
    args[0] === 'start'
      ? 'start'
      : args[0] === 'plugin' &&
          ['install', 'list', 'update', 'cleanup', 'install-legacy', 'list-legacy'].includes(args[1])
        ? `plugin.${args[1]}`
        : args[0] === 'config' && ['show', 'path', 'import'].includes(args[1])
          ? `config.${args[1]}`
          : null;
  if (!command) throw new Error('未知命令，请执行 deviceforge --help');
  const options = {
    command,
    ip: '0.0.0.0',
    port: 7030,
    mcpPort: 7032,
    dataDirectory: resolve(environment.DEVICEFORGE_DATA_DIR || resolve(homedir(), '.deviceforge')),
    marketplaceConfigPath: null,
    marketplaceSources: [{ name: '本地默认市场', url: DEFAULT_MARKETPLACE_URL }],
  };
  const unified = ['plugin.install', 'plugin.update', 'plugin.list', 'plugin.cleanup'].includes(command);
  if (unified) options.apiUrl = environment.DEVICEFORGE_API_URL || 'http://127.0.0.1:7030';
  if (command === 'plugin.cleanup') options.dryRun = true;
  const rest = args.slice(command === 'start' ? 1 : 2);
  if (command === 'plugin.update') {
    if (!rest[0] || !/^[a-z0-9][a-z0-9._-]{0,98}$/.test(rest[0]) || rest[0].startsWith('builtin.'))
      throw new Error('更新要求有效发布 ID');
    options.updateId = rest.shift();
  }
  if (
    ['plugin.install', 'plugin.update', 'plugin.install-legacy', 'config.import'].includes(command)
  ) {
    if (!rest[0] || rest[0].startsWith('-'))
      throw new Error(
        command === 'config.import'
          ? '配置导入要求本地 JSON 文件'
          : command === 'plugin.install-legacy'
            ? '兼容安装要求插件目录、npm 包名或 tgz'
            : '统一安装要求清单 URL 或离线 ZIP',
      );
    options.source = rest.shift();
  }
  // 先确定实例目录，再加载根配置；相对目录始终相对当前命令行解析。
  for (let index = 0; index < rest.length; index += 2) {
    if (rest[index] === '--data-dir' && rest[index + 1])
      options.dataDirectory = resolve(rest[index + 1]);
  }
  if (command === 'start') {
    const configuration = readRootConfiguration(options.dataDirectory);
    options.ip = configuration.server.ip;
    options.port = configuration.server.port;
    options.mcpPort = configuration.server.mcp_port;
    options.marketplaceSources = configuration.marketplace.sources;
  }
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (
      ![
        '--ip',
        '--port',
        '--mcp-port',
        '--data-dir',
        '--marketplace-url',
        '--marketplace-config',
        '--api-url',
        '--release-id',
        '--release-version',
        '--manifest-sha256',
        '--expected-revision',
        '--dry-run',
      ].includes(key) ||
      seen.has(key) ||
      !value ||
      value.startsWith('-')
    )
      throw new Error('选项无效、缺少值或重复');
    seen.add(key);
    if (key === '--port' || key === '--mcp-port') {
      if (command !== 'start' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error('启动端口必须为 1–65535');
      options[key === '--port' ? 'port' : 'mcpPort'] = Number(value);
    } else if (key === '--ip') {
      if (command !== 'start') throw new Error('--ip 只用于启动命令');
      options.ip = value;
    } else if (key === '--data-dir') {
      if (command === 'plugin.cleanup') throw new Error('清理位置由服务器用户目录决定，不接受 --data-dir');
      options.dataDirectory = resolve(value);
    } else if (key === '--dry-run') {
      if (command !== 'plugin.cleanup' || !['true', 'false'].includes(value))
        throw new Error('--dry-run 只用于资源清理，值必须为 true 或 false');
      options.dryRun = value === 'true';
    }
    else if (
      [
        '--api-url',
        '--release-id',
        '--release-version',
        '--manifest-sha256',
        '--expected-revision',
      ].includes(key)
    ) {
      if (!unified || (['plugin.list', 'plugin.cleanup'].includes(command) && key !== '--api-url'))
        throw new Error(`${key} 只用于统一安装命令`);
      const field = {
        '--api-url': 'apiUrl',
        '--release-id': 'releaseId',
        '--release-version': 'releaseVersion',
        '--manifest-sha256': 'manifestSha256',
        '--expected-revision': 'expectedRevision',
      }[key];
      options[field] = value;
    } else {
      if (command !== 'start') throw new Error(`${key} 只用于启动命令`);
      if (seen.has(key === '--marketplace-url' ? '--marketplace-config' : '--marketplace-url'))
        throw new Error('--marketplace-url 与 --marketplace-config 不能同时使用');
      if (key === '--marketplace-url') {
        options.marketplaceSources = [{ name: '自定义市场', url: validateMarketplaceUrl(value) }];
      } else {
        options.marketplaceConfigPath = resolve(value);
        options.marketplaceSources = readMarketplaceConfig(options.marketplaceConfigPath);
      }
    }
  }
  if (command === 'start') {
    readApiToken(environment);
    if (!isIP(options.ip)) throw new Error('--ip 必须为 IPv4 或 IPv6 地址');
    if (options.port === options.mcpPort) throw new Error('前端/API 与 MCP 端口必须不同');
  }
  if (unified) {
    readApiToken(environment);
    let url;
    try {
      url = new URL(options.apiUrl);
    } catch {
      throw new Error('--api-url 必须为 HTTP/HTTPS 服务地址');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['/', '/api/v2', '/api/v2/'].includes(url.pathname)
    )
      throw new Error('--api-url 必须为不含凭据的服务根地址');
    if (options.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedRevision))
      throw new Error('旧修订必须为小写 SHA-256');
    if (command === 'plugin.update' && !options.expectedRevision)
      throw new Error('更新要求 --expected-revision，避免覆盖其他修改');
    if (options.updateId && options.releaseId && options.updateId !== options.releaseId)
      throw new Error('更新目标与发布 ID 不一致');
  }
  return options;
}
