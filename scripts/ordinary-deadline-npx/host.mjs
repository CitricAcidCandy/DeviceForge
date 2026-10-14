import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { npmCommand, spawnManaged, stopManaged } from '../../cli/src/processes.mjs';
import { cleanupNpxRuntime, waitForNpxExit } from '../cli-smoke-cleanup.mjs';
import { clientFor } from '../ordinary-deadline-http/client.mjs';
import { bounded, waitFor } from '../ordinary-deadline-http/wait.mjs';
import { reservePort } from '../ordinary-deadline-http/host.mjs';

export async function assertPortReleased(port) {
  const server = createServer();
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', done);
    });
  } finally {
    if (server.listening)
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
  }
}

export async function prepareNpx({ root, temporary, archive, report }) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key) && key.toUpperCase() !== 'NODE_OPTIONS',
    ),
  );
  const cache = join(temporary, 'cache'),
    directory = join(temporary, 'data');
  const plugins = join(directory, 'plugins');
  Object.assign(environment, {
    npm_config_cache: cache,
    APK_PLUGIN_DIR: plugins,
    DEVICEFORGE_NODE: process.execPath,
    DEVICEFORGE_HTTP_RATE: '10000',
  });
  const npm = npmCommand(environment);
  assert.ok(
    npm.prefix.length === 1 && npm.prefix[0].endsWith('npm-cli.js'),
    '需要可定位的真实 npm-cli.js',
  );
  const npx = join(dirname(npm.prefix[0]), 'npx-cli.js');
  assert.ok((await stat(npx)).isFile());
  const prefix = ['--package', archive, 'deviceforge'];
  const webPort = await reservePort();
  let mcpPort = webPort;
  for (let attempt = 0; attempt < 8 && mcpPort === webPort; attempt++)
    mcpPort = await reservePort();
  assert.notEqual(mcpPort, webPort);
  const base = `http://127.0.0.1:${webPort}`,
    mcp = `http://127.0.0.1:${mcpPort}/mcp`;
  const client = clientFor(base, report, { mcp });
  const commands = (report.cli_commands ??= []);
  const runNpx = async (args, phase) => {
    const managed = spawnManaged(process.execPath, [npx, '--yes', ...args], {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = {
      phase,
      started_at: new Date().toISOString(),
      pid: managed.child.pid,
      command: 'node npx-cli.js',
      args,
    };
    commands.push(entry);
    const decoder = new StringDecoder('utf8');
    let stdout = '',
      stdoutBytes = 0,
      tooLarge = false;
    managed.child.stdout.on('data', (bytes) => {
      stdoutBytes += bytes.length;
      if (stdoutBytes > 1024 * 1024) tooLarge = true;
      else stdout += decoder.write(bytes);
    });
    managed.child.stderr.on('data', () => {});
    try {
      const result = await bounded(managed.closed, 120000, '本次CLI安装/列举退出');
      stdout += decoder.end();
      entry.exit = { code: result.code, signal: result.signal };
      assert.equal(result.failure, undefined);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(tooLarge, false, 'CLI输出必须有界');
      return { code: result.code, stdout };
    } catch (error) {
      entry.error = { name: error.name, code: error.code };
      if (managed.child.exitCode === null && managed.child.signalCode === null) {
        entry.forced_own_command_termination = true;
        try {
          await bounded(stopManaged(managed), 10000, '本次CLI命令收尾');
        } catch (cleanupError) {
          entry.cleanup_error = { name: cleanupError.name, code: cleanupError.code };
        }
        if (managed.child.exitCode === null && managed.child.signalCode === null) {
          entry.exit_unconfirmed = true;
          managed.child.unref();
          managed.child.stdout?.unref?.();
          managed.child.stderr?.unref?.();
        }
      }
      throw error;
    }
  };
  const startupDecoder = new StringDecoder('utf8');
  let running,
    output = '',
    startupBytes = 0;
  const startupLimit = 256 * 1024;
  const target = {
    url: `${base}/api/v2/system/shutdown`,
    webPort,
    mcpPort,
    headers: { 'content-type': 'application/json' },
  };
  const checkPortReleased = (port) => bounded(assertPortReleased(port), 2000, '本次端口释放探测');
  const host = {
    client,
    directory,
    plugins,
    cache,
    prefix,
    runNpx,
    npx,
    webPort,
    mcpPort,
    start: () => {
      assert.equal(running, undefined);
      running = spawnManaged(
        process.execPath,
        [
          npx,
          '--yes',
          ...prefix,
          'start',
          '--port',
          String(webPort),
          '--mcp-port',
          String(mcpPort),
          '--data-dir',
          directory,
        ],
        {
          cwd: root,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      report.npx_wrapper = {
        pid: running.child.pid,
        node: process.execPath,
        node_version: process.version,
        npx_entry: npx,
        started_at: new Date().toISOString(),
        web_port: webPort,
        mcp_port: mcpPort,
        graceful_shutdown: false,
      };
      report.rust_os_pid = {
        directly_collected: false,
        pid: null,
        note: '公开CLI不暴露Rust PID；缓存宿主/served资源摘要仅为身份链，不是OS进程观测',
      };
      running.child.stdout.on('data', (bytes) => {
        startupBytes += bytes.length;
        if (startupBytes <= startupLimit) output += startupDecoder.write(bytes);
      });
      running.child.stderr.on('data', () => {});
    },
    ready: async () => {
      await waitFor(
        () => {
          host.assertRunning();
          assert.ok(startupBytes <= startupLimit);
          return output.includes('DeviceForge 已启动');
        },
        Boolean,
        '真实npx就绪',
        20000,
      );
      assert.ok(output.includes('监听 0.0.0.0'), '不传--ip时必须真实使用默认LAN监听');
      await client.json('/api/v2/health');
      report.default_without_token = true;
      report.npx_wrapper.ready_at = new Date().toISOString();
    },
    assertRunning: () => {
      assert.ok(running && !running.failure);
      assert.equal(running.child.pid, report.npx_wrapper.pid);
      assert.equal(running.child.exitCode, null, '本次npx包装进程不得提前退出');
      assert.equal(running.child.signalCode, null);
    },
    shutdown: async () => {
      host.assertRunning();
      const started = performance.now();
      const before = report.requests.length;
      try {
        await client.post('/api/v2/system/shutdown', undefined, {
          signal: AbortSignal.timeout(10000),
        });
      } finally {
        (report.shutdown_attempts ??= []).push(
          ...report.requests
            .slice(before)
            .filter((item) => item.path === '/api/v2/system/shutdown'),
        );
      }
      const ended = await waitForNpxExit(
        running,
        Math.max(0, 10000 - (performance.now() - started)),
      );
      // 先保存实际退出；端口或退出断言失败不能抹去原观察。
      report.npx_wrapper.shutdown_elapsed_ms = performance.now() - started;
      if (ended) {
        report.npx_wrapper.exit = { code: ended.code, signal: ended.signal };
        if (ended.failure)
          report.npx_wrapper.exit_error = { name: ended.failure.name, code: ended.failure.code };
      } else report.npx_wrapper.shutdown_exit_unconfirmed = true;
      assert.ok(ended, 'npx必须在原10秒正常关闭观察窗口内退出');
      assert.equal(ended.failure, undefined);
      assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: 0, signal: null });
      await host.portsReleased();
      report.npx_wrapper.graceful_shutdown = true;
    },
    portsReleased: async () => {
      const ports = [],
        errors = [];
      for (const [role, port] of [
        ['web', webPort],
        ['mcp', mcpPort],
      ]) {
        try {
          await checkPortReleased(port);
          ports.push({ role, port, released: true });
        } catch (error) {
          ports.push({
            role,
            port,
            released: false,
            error: { name: error.name, code: error.code },
          });
          errors.push(error);
        }
      }
      report.ports = ports;
      (report.port_release_attempts ??= []).push({
        checked_at: new Date().toISOString(),
        probe_timeout_ms: 2000,
        ports,
      });
      // 两端口独立检查完才抛首错；后续清理证据不得覆盖这一轮。
      if (errors.length) throw errors[0];
    },
    finish: async () => {
      if (!running) return;
      let failure;
      if (report.npx_wrapper.graceful_shutdown) {
        try {
          await host.portsReleased();
          return;
        } catch (error) {
          failure = error;
          report.npx_wrapper.graceful_shutdown = false;
          report.finish_port_error ??= { name: error.name, code: error.code };
        }
      }
      if (
        !failure &&
        !running.failure &&
        running.child.exitCode === null &&
        running.child.signalCode === null
      ) {
        try {
          await host.shutdown();
          return;
        } catch (error) {
          failure = error;
          report.finish_shutdown_error ??= { name: error.name, code: error.code };
        }
      }
      let cleanupFailure;
      try {
        const result = await cleanupNpxRuntime({
          running,
          target,
          assertPortReleased: checkPortReleased,
        });
        report.failure_cleanup = result;
        assert.equal(result.passed, true, '自有npx收尾未确认，保持失败与目录');
      } catch (error) {
        cleanupFailure = error;
        report.finish_cleanup_error = { name: error.name, code: error.code };
      }
      // 清理成功不能消除先前的退出或端口失败，优先回流原错误。
      if (failure) throw failure;
      if (cleanupFailure) throw cleanupFailure;
    },
  };
  return host;
}
