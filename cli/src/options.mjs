import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';

export const help = `DeviceForge · 设备工坊
用法：deviceforge start [--ip 0.0.0.0] [--port 7030] [--mcp-port 7032] [--data-dir 目录]
      deviceforge plugin install <本地目录|npm包名|本地tgz> [--data-dir 目录]
      deviceforge plugin list [--data-dir 目录]
      deviceforge --help

start 默认监听所有 IPv4 网卡，提供局域网前端/API 和独立 MCP 端口。
局域网启动须配置 APK_API_TOKEN；令牌不打印、也不写入前端资源。
仅 --ip 127.0.0.1 或 ::1 可未配置令牌，生成本次运行随机令牌。
数据默认保存在用户目录 .deviceforge，可用 DEVICEFORGE_DATA_DIR 配置。
插件由管理员安装，安装后重启服务加载；同 ID 不覆盖已有插件。
`;

export function parseOptions(args, environment = process.env) {
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) return { command: 'help' };
  const command = args[0] === 'start' ? 'start' : args[0] === 'plugin' && ['install', 'list'].includes(args[1]) ? `plugin.${args[1]}` : null;
  if (!command) throw new Error('未知命令，请执行 deviceforge --help');
  const options = { command, ip: '0.0.0.0', port: 7030, mcpPort: 7032, dataDirectory: resolve(environment.DEVICEFORGE_DATA_DIR || resolve(homedir(), '.deviceforge')) };
  const rest = args.slice(command === 'start' ? 1 : 2);
  if (command === 'plugin.install') {
    if (!rest[0] || rest[0].startsWith('-')) throw new Error('安装命令要求插件目录、npm 包名或 tgz');
    options.source = rest.shift();
  }
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]; const value = rest[i + 1];
    if (!['--ip', '--port', '--mcp-port', '--data-dir'].includes(key) || seen.has(key) || !value || value.startsWith('-')) throw new Error('选项无效、缺少值或重复');
    seen.add(key);
    if (key === '--port' || key === '--mcp-port') {
      if (command !== 'start' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('启动端口必须为 1–65535');
      options[key === '--port' ? 'port' : 'mcpPort'] = Number(value);
    } else if (key === '--ip') {
      if (command !== 'start') throw new Error('--ip 只用于启动命令');
      options.ip = value;
    } else options.dataDirectory = resolve(value);
  }
  if (command === 'start') {
    if (!isIP(options.ip)) throw new Error('--ip 必须为 IPv4 或 IPv6 地址');
    if (options.port === options.mcpPort) throw new Error('前端/API 与 MCP 端口必须不同');
  }
  return options;
}
