import { normalize } from './normalize.ts';

const LIMIT = 512 * 1024;
async function readRequest() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > LIMIT) throw new Error('请求超过协议1上限');
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('protocol_version' in value && value.protocol_version === 1) ||
      !('request_id' in value && typeof value.request_id === 'string' &&
        value.request_id.length > 0 && value.request_id.length <= 128) ||
      !('operation' in value && typeof value.operation === 'string') || !('input' in value))
    throw new Error('协议或请求身份无效');
  return { requestId: value.request_id, operation: value.operation, input: value.input };
}
try {
  const request = await readRequest();
  let response: { protocol_version: 1; request_id: string; result?: ReturnType<typeof normalize>; error?: string };
  try {
    if (request.operation !== 'normalize') throw new Error('未知操作');
    response = { protocol_version: 1, request_id: request.requestId, result: normalize(request.input) };
  } catch {
    response = { protocol_version: 1, request_id: request.requestId, error: '操作或输入不符合文本规范化契约' };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch {
  // 身份未知时不回显原输入，只输出固定诊断；stdout 保持为纯协议通道。
  process.stderr.write('工作区示例请求解析失败\n');
  process.exitCode = 1;
}
