const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function respond(request) {
  if (!object(request) || request.protocol_version !== 1 || typeof request.request_id !== 'string' ||
      !request.request_id || request.request_id.length > 128 || /[\u0000-\u001f]/u.test(request.request_id)) {
    throw new Error('协议或请求身份无效');
  }
  const response = { protocol_version: 1, request_id: request.request_id };
  const input = request.input;
  if (request.operation !== 'echo' || !object(input) || Object.keys(input).length !== 1 ||
      typeof input.message !== 'string' || [...input.message].length > 1000) {
    return { ...response, error: '操作或输入不符合回显契约' };
  }
  return { ...response, result: { message: input.message, source: 'demo_debugger_server' } };
}

// 协议 1 等待 stdin EOF；输入大小与总等待都有界，不创建工具、文件、网络或设备资源。
export function readRequest(stream, { limit = 65536, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener('data', data);
      stream.removeListener('end', end);
      stream.removeListener('error', error);
      stream.pause();
    };
    const error = () => { cleanup(); reject(new Error('请求读取失败或超过限额')); };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) { error(); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new Error('请求不是有效 UTF-8 JSON')); }
    };
    const timer = setTimeout(error, timeoutMs);
    stream.on('data', data);
    stream.once('end', end);
    stream.once('error', error);
  });
}
