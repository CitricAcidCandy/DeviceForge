#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { defaultDeployment } from './backend-console/deployment.mjs';
import { runBackendConsole } from './backend-console/console.mjs';

const help = `DeviceForge 后端控制台
用法：启动后端.bat [--background | --status | --stop | --help]

双击启动后端.bat：启动或连接原预览后端，并持续显示服务器日志。
输入 stop 回车，或按 Ctrl+C：正常停止后端并退出。
输入 quit 回车：仅退出日志窗口，后端继续运行。
输入 status 回车：查看后端状态。
双击停止后端.bat，或启动后端.bat --stop：主动停止同一后端。
--background 只启动后台服务；--status 只检查状态。

沿用原预览数据、插件和 0.0.0.0:7031 监听，不重新编译或迁移目录。
停止时先请求服务关闭，不结束无关进程；直接关闭窗口不能保证正常停止。
`;

const modes = new Map([
  ['--help', 'help'],
  ['-h', 'help'],
  ['/?', 'help'],
  ['-Help', 'help'],
  ['--background', 'background'],
  ['-NoFollow', 'background'],
  ['--status', 'status'],
  ['-Status', 'status'],
  ['--stop', 'stop'],
  ['-Stop', 'stop'],
]);

try {
  const args = process.argv.slice(2);
  const mode = args.length === 0 ? 'follow' : args.length === 1 ? modes.get(args[0]) : undefined;
  if (!mode) throw new Error('参数无效，请运行 启动后端.bat --help');
  if (mode === 'help') console.log(help);
  else {
    const root = fileURLToPath(new URL('../', import.meta.url));
    process.exitCode = await runBackendConsole(defaultDeployment(root), { mode });
  }
} catch (error) {
  console.error(`后端控制台失败：${error.message}`);
  process.exitCode = 1;
}
