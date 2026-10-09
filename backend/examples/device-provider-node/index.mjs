// 标准输出只发送公开协议帧；示例不运行平台工具、不创建外部资源。
const LIMIT = 64 * 1024;
async function readRequest() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('示例请求超过 64 KiB');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (request?.protocol_version !== 1 || typeof request.request_id !== 'string' || request.request_id.length > 200) {
    throw new Error('示例仅接受协议 1 的合法请求');
  }
  return request;
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function execute(operation, input) {
  if (!object(input)) throw new Error('输入必须为对象');
  if (operation === 'discover') {
    if (Object.keys(input).length) throw new Error('发现不接收业务参数');
    return [{
      id: 'demo-device', state: 'online', model: '模拟设备，未连接硬件',
      capabilities: [{ id: 'device.echo', version: 1, available: true }],
    }];
  }
  if (!object(input.input) || Object.keys(input).some((key) => !['device_id', 'input'].includes(key))) {
    throw new Error('能力调用须使用公开标准输入');
  }
  if (operation === 'describe' && input.device_id === null) {
    return { synthetic_demo: true, platform: 'synthetic_demo', persistent_session: false };
  }
  if (operation === 'echo' && input.device_id === 'demo-device') {
    return { synthetic_demo: true, device_id: input.device_id, value: input.input };
  }
  throw new Error('示例操作或设备不存在');
}
try {
  const request = await readRequest();
  let response;
  try {
    response = { protocol_version: 1, request_id: request.request_id, result: execute(request.operation, request.input) };
  } catch (error) {
    response = { protocol_version: 1, request_id: request.request_id, error: error.message };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch {
  // 无法关联的协议错误仅以非零退出表示，不回显请求内容。
  process.exitCode = 1;
}
