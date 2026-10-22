import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { start } from '../src/start.mjs';
import { loadRuntime } from '../src/runtime.mjs';
import { inside } from '../src/paths.mjs';

// 不让其他端测试的部署配置影响本次真实启动；测试目录和进程各自拥有。
const cleanEnvironment = (directory) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)),
  ),
  DEVICEFORGE_USER_DIR: join(directory, 'user', '.deviceforge'),
});

async function removeTemporary(directory) {
  const target = resolve(directory);
  if (!inside(resolve(tmpdir()), target) || target === resolve(tmpdir()))
    throw new Error('启动测试清理路径越界');
  await rm(target, { recursive: true, force: true });
}

async function assertPortFree(port) {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
}

async function assertGracefulLogs(directory, token) {
  const logs = (await readdir(join(directory, 'logs'))).filter((name) => name.endsWith('.jsonl'));
  assert.ok(logs.length > 0);
  const text = (
    await Promise.all(logs.map((name) => readFile(join(directory, 'logs', name), 'utf8')))
  ).join('');
  if (token) assert.ok(!text.includes(token));
  assert.ok(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .some((record) => record.fields?.message === '宿主运行已结束'),
  );
}

async function reserve(ip = '127.0.0.1') {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, ip, resolve));
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
test('真实后端通过独立前端/API 与 MCP 端口共享任务，取消关闭所有监听', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-start-'));
  const web = await reserve();
  const mcp = await reserve();
  await web.close();
  await mcp.close();
  const controller = new AbortController();
  const token = randomBytes(32).toString('hex');
  let notify;
  const ready = new Promise((resolve) => {
    notify = resolve;
  });
  const running = start(
    { ip: '127.0.0.1', port: web.port, mcpPort: mcp.port, dataDirectory: directory },
    {
      signal: controller.signal,
      environment: { ...cleanEnvironment(directory), APK_API_TOKEN: token },
      onReady: notify,
    },
  );
  // 同时观察启动错误，失败测试不等待未触发的 onReady。
  try {
    await Promise.race([ready, running]);
    const base = `http://127.0.0.1:${web.port}`;
    const headers = { authorization: `Bearer ${token}` };
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DeviceForge/);
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/v1/health`, { headers: { authorization: 'Bearer wrong-token' } }))
        .status,
      401,
    );
    assert.equal((await fetch(`${base}/api/v1/health`, { headers })).status, 200);
    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const denied = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
        method: 'POST',
        headers: {
          ...(authorization ? { authorization } : {}),
          origin: base,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(denied.status, 401);
    }
    const reply = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        origin: base,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(reply.status, 200);
    assert.ok(
      (await reply.json()).result.tools.some((tool) => tool.name === 'deviceforge.get_job'),
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${mcp.port}/api/v1/health`, { headers })).status,
      404,
    );
    // fetch 可能自行重写 Host，使用原生请求确认真实错误 Host 到达服务。
    const wrongHost = await new Promise((resolve, reject) => {
      const outgoing = request(
        base,
        { headers: { host: `unrelated.example:${web.port}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
    assert.equal(wrongHost, 403);
    controller.abort();
    await running;
    await assertGracefulLogs(directory, token);
    await assert.rejects(
      fetch(`${base}/api/v1/health`, { headers, signal: AbortSignal.timeout(1000) }),
    );
    await assertPortFree(web.port);
    await assertPortFree(mcp.port);
  } finally {
    controller.abort();
    await running.catch(() => {});
    await removeTemporary(directory);
  }
});

// 这些真实用例须在主代理重建 runtime 后运行；旧 Rust 程序仍可能拒绝空令牌。
for (const ip of ['127.0.0.1', '0.0.0.0']) {
  test(`免令牌 ${ip === '127.0.0.1' ? '回环' : '局域网'} 启动支持 HTTP/MCP 并正常退出`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deviceforge-start-open-'));
    const web = await reserve();
    const mcp = await reserve();
    await web.close();
    await mcp.close();
    const controller = new AbortController();
    let notify;
    const ready = new Promise((resolve) => {
      notify = resolve;
    });
    let announced = false;
    const environment = cleanEnvironment(directory);
    // 分别验证未配置与显式空字符串，二者都不得生成随机令牌。
    if (ip === '0.0.0.0') environment.APK_API_TOKEN = '';
    const running = start(
      { ip, port: web.port, mcpPort: mcp.port, dataDirectory: directory },
      {
        signal: controller.signal,
        environment,
        onReady: (message) => {
          announced = true;
          notify(message);
        },
      },
    );
    try {
      const message = await Promise.race([ready, running]);
      assert.equal(announced, true, '真实后端必须就绪后才验收公开端口');
      assert.match(message, new RegExp(`监听 ${ip.replaceAll('.', '\\.')}`));
      assert.ok(!message.includes('Bearer'));
      const addresses =
        ip === '0.0.0.0'
          ? [
              ...new Set([
                '127.0.0.1',
                ...Object.values(networkInterfaces())
                  .flat()
                  .filter(Boolean)
                  .filter((item) => !item.internal && item.family === 'IPv4')
                  .map((item) => item.address),
              ]),
            ]
          : ['127.0.0.1'];
      for (const address of addresses) {
        const base = `http://${address}:${web.port}`;
        const health = await fetch(`${base}/api/v2/health`, { signal: AbortSignal.timeout(3000) });
        assert.equal(health.status, 200);
        assert.equal((await health.json()).log_id, health.headers.get('x-deviceforge-log-id'));
        const plugins = await fetch(`${base}/api/v2/plugins`, {
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(plugins.status, 200, '免鉴权部署的管理接口必须可用');
        assert.deepEqual((await plugins.json()).data, []);
        const reply = await fetch(`http://${address}:${mcp.port}/mcp`, {
          method: 'POST',
          headers: {
            origin: base,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(reply.status, 200);
        const body = await reply.json();
        assert.equal(
          body.result._meta['deviceforge/log_id'],
          reply.headers.get('x-deviceforge-log-id'),
        );
        assert.ok(body.result.tools.some((tool) => tool.name === 'deviceforge.get_job'));
      }
      if (ip === '127.0.0.1') {
        // 中止启动器触发内部无 Authorization 的正常关闭请求。
        controller.abort();
      } else {
        // 无令牌管理请求也应让后端和启动器自然退出。
        const response = await fetch(`http://127.0.0.1:${web.port}/api/v2/system/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).data.stopping, true);
      }
      let timer;
      try {
        await Promise.race([
          running,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('免令牌启动器未正常退出')), 10000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await assertGracefulLogs(directory);
      await assertPortFree(web.port);
      await assertPortFree(mcp.port);
    } finally {
      controller.abort();
      await running.catch(() => {});
      await removeTemporary(directory);
    }
  });
}

test('市场未提供 HTTP 服务时宿主仍可启动，退出后保留独立市场监听', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-independent-market-'));
  const web = await reserve();
  const mcp = await reserve();
  const marketplace = await reserve();
  let connections = 0;
  marketplace.server.on('connection', (socket) => {
    connections += 1;
    socket.destroy();
  });
  await web.close();
  await mcp.close();
  const url = `http://127.0.0.1:${marketplace.port}`;
  const controller = new AbortController();
  let notify;
  const ready = new Promise((resolve) => {
    notify = resolve;
  });
  let running;
  try {
    const runtime = await loadRuntime();
    running = start(
      {
        ip: '127.0.0.1',
        port: web.port,
        mcpPort: mcp.port,
        dataDirectory: directory,
        marketplaceSources: [{ name: '独立市场', url }],
      },
      {
        signal: controller.signal,
        environment: cleanEnvironment(directory),
        runtime: { ...runtime, resourceServer: join(directory, 'not-bundled-resource-server') },
        onReady: notify,
      },
    );
    const message = await Promise.race([ready, running]);
    assert.ok(message.includes(`市场来源：${url}`));
    assert.ok(message.includes('资源服务需独立启动'));
    assert.equal((await fetch(`http://127.0.0.1:${web.port}/api/v1/health`)).status, 200);
    assert.ok(!(await readdir(directory)).includes('resources'));
    controller.abort();
    await running;
    assert.equal(connections, 0);
    assert.equal(marketplace.server.listening, true);
    await assertPortFree(web.port);
    await assertPortFree(mcp.port);
  } finally {
    controller.abort();
    await running?.catch(() => {});
    await marketplace.close();
    await removeTemporary(directory);
  }
});

for (const occupied of ['web', 'mcp']) {
  test(`免令牌局域网启动遇到${occupied === 'web' ? '第一' : '第二'}端口冲突时收敛且保留原监听`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deviceforge-start-fail-'));
    // Windows 可同时绑定通配与具体地址；冲突夹具必须占用实际同一监听地址。
    const web = await reserve('0.0.0.0');
    const mcp = await reserve('0.0.0.0');
    await (occupied === 'web' ? mcp : web).close();
    const retained = occupied === 'web' ? web : mcp;
    let announced = false;
    try {
      await assert.rejects(
        start(
          { ip: '0.0.0.0', port: web.port, mcpPort: mcp.port, dataDirectory: directory },
          {
            environment: cleanEnvironment(directory),
            onReady: () => {
              announced = true;
            },
            // 冲突发生在派生后端之前，无需读取或运行旧 Rust 包。
            runtime: { binary: process.execPath, web: directory },
          },
        ),
        /EADDRINUSE/,
      );
      assert.equal(announced, false);
      assert.equal(retained.server.listening, true, '原有占用端口的服务不得被关闭');
      await assertPortFree(occupied === 'web' ? mcp.port : web.port);
      await retained.close();
      await assertPortFree(retained.port);
    } finally {
      if (retained.server.listening) await retained.close();
      await removeTemporary(directory);
    }
  });
}
