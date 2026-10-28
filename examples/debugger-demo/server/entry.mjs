import { readRequest, respond } from './protocol.mjs';

try {
  const response = respond(await readRequest(process.stdin));
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch {
  // 固定诊断不回显请求内容；无法匹配身份时 stdout 保持为空。
  process.stderr.write('独立回显请求读取或身份校验失败\n');
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}
