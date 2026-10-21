// 真实生命周期只运行当前 debug 空插件服务，不读取或停止任何已有预览。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureServer, serverStatus, stopServer } from '../backend-console/server.mjs';
import { defaultDeployment } from '../backend-console/deployment.mjs';
import { runBackendConsole } from '../backend-console/console.mjs';
import {
  ownedDirectory,
  testConfiguration,
  freePort,
  healthy,
  project,
} from './backend-console-fixture.mjs';

async function interact(config, commands) {
  const input = new PassThrough();
  const writes = [];
  const listeners = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
  let finished = false;
  const running = runBackendConsole(config, {
    input,
    write: (value) => writes.push(String(value)),
  });
  running.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  const timeout = new AbortController();
  try {
    const until = Date.now() + 30000;
    while (!input.listenerCount('data')) {
      if (finished) {
        await running;
        assert.fail('交互输入建立前控制台意外退出');
      }
      assert.ok(Date.now() < until, '等待控制台输入超时');
      await delay(50);
    }
    input.write(commands);
    const code = await Promise.race([
      running,
      delay(45000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error('等待交互控制台完成超时');
      }),
    ]);
    assert.equal(code, 0);
    assert.ok(writes.length > 0);
  } finally {
    timeout.abort();
    input.end();
    await running.catch(() => {});
    input.destroy();
  }
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
    listeners,
    '交互结束后不能遗留进程信号监听器',
  );
}

export function registerLifecycleTests() {
  test('默认部署只解析启动器路径，字段完整且不会创建测试外目录', async () => {
    await ownedDirectory(async (directory) => {
      assert.deepEqual(await readdir(directory), []);
      const config = await defaultDeployment(directory);
      for (const key of [
        'directory',
        'binary',
        'dataDirectory',
        'pluginDirectory',
        'browserPluginDirectory',
        'logDirectory',
      ])
        assert.equal(typeof config[key], 'string', `部署缺少 ${key}`);
      assert.equal(Number.isInteger(config.port), true);
      assert.deepEqual(await readdir(directory), [], '解析默认部署不能启动服务或创建目录');
    });
  });

  test(
    '不同程序即使同端口伪造健康响应也不能复用或停止，监听保持可用',
    { skip: process.platform !== 'win32' },
    async () => {
      await ownedDirectory(async (directory) => {
        const config = await testConfiguration(directory);
        const impostor = createServer((_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ log_id: 'fixture', data: { status: 'ok', api_version: 2 } }),
          );
        });
        await new Promise((resolve, reject) => {
          impostor.once('error', reject);
          impostor.listen(config.port, '127.0.0.1', resolve);
        });
        try {
          await healthy(config.port);
          await assert.rejects(
            ensureServer(config, { background: true }),
            /占用|身份|程序|后端|进程/,
          );
          await assert.rejects(serverStatus(config), /占用|身份|程序|后端|进程/);
          await assert.rejects(stopServer(config), /占用|身份|程序|后端|进程/);
          await healthy(config.port);
        } finally {
          impostor.closeAllConnections();
          await new Promise((resolve, reject) =>
            impostor.close((error) => (error ? reject(error) : resolve())),
          );
        }
        await freePort(config.port);
      });
    },
  );

  test(
    '真实空插件后台启动可重复复用，拒绝伪造身份停止，正常关闭释放端口并清理状态',
    { timeout: 120000, skip: process.platform !== 'win32' },
    async () => {
      await access(
        join(
          project,
          'backend',
          'target',
          'debug',
          process.platform === 'win32' ? 'apk-server.exe' : 'apk-server',
        ),
      );
      await ownedDirectory(async (directory) => {
        const config = await testConfiguration(directory);
        let server;
        try {
          assert.equal((await serverStatus(config)).running, false);
          server = await ensureServer(config, { background: true });
          assert.ok(Number.isInteger(server.pid) && server.pid > 0);
          assert.ok(server.startTime);
          assert.equal(server.binary, config.binary);
          assert.equal(typeof server.stdoutPath, 'string');
          assert.equal(typeof server.stderrPath, 'string');
          await healthy(config.port);
          const status = await serverStatus(config);
          assert.equal(status.running, true);
          assert.equal(status.server.pid, server.pid);
          assert.equal(status.server.startTime, server.startTime);
          const reused = await ensureServer(config, { background: true });
          assert.equal(reused.pid, server.pid);
          assert.equal(reused.startTime, server.startTime);
          await assert.rejects(
            stopServer(config, { ...server, startTime: `${server.startTime}-forged` }),
            /身份|复用/,
          );
          await healthy(config.port);
          const result = await stopServer(config, reused);
          assert.equal(result.stopped, true);
          assert.equal(result.forced, false);
          assert.equal(result.pid, server.pid);
          assert.equal((await serverStatus(config)).running, false);
          await freePort(config.port);
          const again = await stopServer(config);
          assert.equal(again.stopped, true, '重复停止应按已停止状态完成');
          assert.equal(again.pid, undefined, '重复停止不应命中其他进程');
          const logFiles = (await readdir(config.logDirectory)).filter((name) =>
            name.endsWith('.jsonl'),
          );
          const logs = (
            await Promise.all(
              logFiles.map((name) => readFile(join(config.logDirectory, name), 'utf8')),
            )
          ).join('\n');
          assert.match(logs, /宿主运行已结束/);
        } finally {
          if (server) await stopServer(config, server);
          await freePort(config.port);
        }
      });
    },
  );

  test(
    '真实服务的标准输入 status/quit 保留后端，随后 status/stop 正常停止且回收监听器',
    { timeout: 120000, skip: process.platform !== 'win32' },
    async () => {
      await ownedDirectory(async (directory) => {
        const config = await testConfiguration(directory);
        let server;
        try {
          server = await ensureServer(config, { background: true });
          await interact(config, 'status\nquit\n');
          await healthy(config.port);
          const retained = await serverStatus(config);
          assert.equal(retained.running, true);
          assert.equal(retained.server.pid, server.pid);
          assert.equal(retained.server.startTime, server.startTime);
          await interact(config, 'status\nstop\n');
          assert.equal((await serverStatus(config)).running, false);
          await freePort(config.port);
        } finally {
          if (server) await stopServer(config, server);
          await freePort(config.port);
        }
      });
    },
  );
}
