import { createServer, request as upstreamRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { inside } from './paths.mjs';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
function headers(source) {
  const result = { ...source };
  for (const name of [
    ...hopHeaders,
    ...(source.connection || '').split(',').map((value) => value.trim().toLowerCase()),
  ])
    delete result[name];
  return result;
}
function failure(response, status, message) {
  if (!response.headersSent)
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
  response.end(message);
}

// 仅反向代理固定回环后端，不接收调用方指定的地址，也不替调用方注入令牌。
function proxy(request, response, backendPort) {
  const forwarded = headers(request.headers);
  forwarded.host = `127.0.0.1:${backendPort}`;
  const upstream = upstreamRequest(
    {
      host: '127.0.0.1',
      port: backendPort,
      path: request.url,
      method: request.method,
      headers: forwarded,
    },
    (incoming) => {
      response.writeHead(incoming.statusCode || 502, headers(incoming.headers));
      incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    },
  );
  upstream.setTimeout(130000, () => upstream.destroy());
  upstream.on('error', () => failure(response, 502, '后端连接失败'));
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
}

async function staticFile(request, response, root, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    failure(response, 405, '静态资源只支持 GET/HEAD');
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    failure(response, 400, '资源路径编码无效');
    return;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) {
    failure(response, 400, '资源路径无效');
    return;
  }
  let path = resolve(root, `.${decoded}`);
  if (!inside(root, path)) {
    failure(response, 400, '资源路径越界');
    return;
  }
  if (decoded === '/') path = join(root, 'index.html');
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    if (!extname(path)) {
      path = join(root, 'index.html');
      metadata = await lstat(path);
    } else {
      failure(response, 404, '资源不存在');
      return;
    }
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || !inside(root, await realpath(path))) {
    failure(response, 404, '资源不存在');
    return;
  }
  response.writeHead(200, {
    'content-type': mime[extname(path)] || 'application/octet-stream',
    'content-length': metadata.size,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  });
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(path), response);
}

export async function startWebServer({
  port,
  backendPort,
  web,
  ip = '127.0.0.1',
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`],
  mcpOnly = false,
}) {
  const server = createServer((request, response) => {
    // 允许实际网卡地址；仍拒绝与监听端点无关的 Host。
    if (!allowedHosts.includes(request.headers.host)) {
      failure(response, 403, '请求主机不允许');
      return;
    }
    let url;
    if (!request.url.startsWith('/') || request.url.startsWith('//')) {
      failure(response, 400, '请求地址必须为本站路径');
      return;
    }
    try {
      url = new URL(request.url, `http://${request.headers.host}`);
    } catch {
      failure(response, 400, '请求地址无效');
      return;
    }
    if (mcpOnly) {
      if (url.pathname === '/mcp') proxy(request, response, backendPort);
      else failure(response, 404, '此端口仅提供 /mcp');
      return;
    }
    if (url.pathname === '/mcp' || url.pathname.startsWith('/api/'))
      proxy(request, response, backendPort);
    else
      staticFile(request, response, web, url.pathname).catch(() =>
        failure(response, 500, '静态资源读取失败'),
      );
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ip, resolve);
  });
  return {
    server,
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
