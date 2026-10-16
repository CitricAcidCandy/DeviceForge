import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';

export const DEFAULT_MARKETPLACE_URL = 'http://127.0.0.1:7040';

export const help = `DeviceForge · 设备工坊
用法：deviceforge start [--ip 0.0.0.0] [--port 7030] [--mcp-port 7032] [--data-dir 目录] [--marketplace-url 地址 | --marketplace-config 文件]
      deviceforge plugin install <本地目录|npm包名|本地tgz> [--data-dir 目录]
      deviceforge plugin list [--data-dir 目录]
      deviceforge --help

start 默认监听所有 IPv4 网卡，提供局域网前端/API 和独立 MCP 端口。
本地和局域网默认免鉴权；可选 APK_API_TOKEN 配置后不得包含空白。
不自动生成随机令牌；配置的令牌不打印、也不写入前端资源。
数据默认保存在用户目录 .deviceforge，可用 DEVICEFORGE_DATA_DIR 配置。
资源服务独立启动；市场默认地址为 ${DEFAULT_MARKETPLACE_URL}。
--marketplace-url 指定市场地址；--marketplace-config 指定包含 sources 的 JSON 来源清单，两者互斥。
插件安装后须显式加载；同 ID 不覆盖已有插件。
`;

export function validateMarketplaceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('市场地址不能为空');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('市场地址必须为有效 URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('市场地址必须为不含凭证、查询参数或片段的 HTTP 地址');
  return parsed.toString().replace(/\/$/, '');
}

export function readMarketplaceConfig(path = null) {
  if (!path) return [{ name: '本地默认市场', url: DEFAULT_MARKETPLACE_URL }];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`市场配置读取失败：${error.message}`);
  }
  const sources = Array.isArray(parsed) ? parsed : parsed?.sources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 32)
    throw new Error('市场配置必须包含 1–32 个 sources');
  const seen = new Set();
  return sources.map((source, index) => {
    const url = validateMarketplaceUrl(typeof source === 'string' ? source : source?.url);
    if (seen.has(url)) throw new Error(`市场来源重复：${url}`);
    seen.add(url);
    const name =
      typeof source === 'object' && typeof source.name === 'string' && source.name.trim()
        ? source.name.trim().slice(0, 80)
        : `市场来源 ${index + 1}`;
    return { name, url };
  });
}

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
      : args[0] === 'plugin' && ['install', 'list'].includes(args[1])
        ? `plugin.${args[1]}`
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
  const rest = args.slice(command === 'start' ? 1 : 2);
  if (command === 'plugin.install') {
    if (!rest[0] || rest[0].startsWith('-'))
      throw new Error('安装命令要求插件目录、npm 包名或 tgz');
    options.source = rest.shift();
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
    } else if (key === '--data-dir') options.dataDirectory = resolve(value);
    else {
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
  return options;
}
