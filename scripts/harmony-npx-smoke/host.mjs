import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { npmCommand, spawnManaged, stopManaged } from '../../cli/src/processes.mjs';
import { cleanupNpxRuntime, waitForNpxExit } from '../cli-smoke-cleanup.mjs';
import { assertPortReleased } from '../ordinary-deadline-npx/host.mjs';
import { reservePort } from '../ordinary-deadline-http/host.mjs';
import { bounded, waitFor } from '../ordinary-deadline-http/wait.mjs';
import { authenticatedClient } from './client.mjs';

export async function prepareHost({
  root,
  temporary,
  archive,
  report,
  phase,
  token,
  bindingsPath,
  ports,
}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key) && key.toUpperCase() !== 'NODE_OPTIONS',
    ),
  );
  const directory = join(temporary, 'data'),
    plugins = join(directory, 'plugins'),
    cache = join(temporary, 'cache');
  Object.assign(environment, {
    npm_config_cache: cache,
    APK_PLUGIN_DIR: plugins,
    APK_OPERATION_BINDINGS: bindingsPath,
    DEVICEFORGE_NODE: process.execPath,
    DEVICEFORGE_HTTP_RATE: '10000',
  });
  if (token) environment.APK_API_TOKEN = token;
  const npm = npmCommand(environment);
  assert.ok(npm.prefix.length === 1 && npm.prefix[0].endsWith('npm-cli.js'));
  const npx = join(dirname(npm.prefix[0]), 'npx-cli.js');
  assert.ok((await stat(npx)).isFile());
  const prefix = ['--package', archive, 'deviceforge'];
  const webPort = ports?.webPort ?? (await reservePort());
  let mcpPort = ports?.mcpPort ?? webPort;
  for (let attempt = 0; attempt < 8 && mcpPort === webPort; attempt++)
    mcpPort = await reservePort();
  assert.notEqual(webPort, mcpPort);
  const base = `http://127.0.0.1:${webPort}`,
    mcp = `http://127.0.0.1:${mcpPort}/mcp`;
  const client = authenticatedClient(base, mcp, report, phase.phase, token);
  const checkPort = (port) => bounded(assertPortReleased(port), 2000, '本次端口释放');
  let running;
  const host = {
    client,
    directory,
    plugins,
    cache,
    prefix,
    npx,
    webPort,
    mcpPort,
    runNpx: async (args, purpose) => {
      const managed = spawnManaged(process.execPath, [npx, '--yes', ...args], {
        cwd: root,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const command = {
        phase: phase.phase,
        purpose,
        pid: managed.child.pid,
        args,
        started_at: new Date().toISOString(),
      };
      report.cli_commands.push(command);
      const decoder = new StringDecoder('utf8');
      let stdout = '',
        bytes = 0;
      managed.child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) stdout += decoder.write(chunk);
      });
      managed.child.stderr.on('data', () => {});
      try {
        const ended = await bounded(managed.closed, 120000, 'CLI安装/列举');
        stdout += decoder.end();
        command.exit = { code: ended.code, signal: ended.signal };
        assert.equal(ended.failure, undefined);
        assert.equal(ended.code, 0);
        assert.equal(ended.signal, null);
        assert.ok(bytes <= 1024 * 1024);
        if (token) assert.ok(!stdout.includes(token));
        return { stdout, code: ended.code };
      } catch (error) {
        command.error = { name: error.name, code: error.code };
        if (managed.child.exitCode === null && managed.child.signalCode === null) {
          command.forced_own_command_termination = true;
          try {
            await bounded(stopManaged(managed), 10000, 'CLI命令清理');
          } catch (cleanupError) {
            command.cleanup_error = { name: cleanupError.name, code: cleanupError.code };
          }
          if (managed.child.exitCode === null && managed.child.signalCode === null) {
            command.exit_unconfirmed = true;
            managed.child.unref();
            managed.child.stdout?.unref?.();
            managed.child.stderr?.unref?.();
          }
        }
        throw error;
      }
    },
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
        { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const decoder = new StringDecoder('utf8');
      let output = '',
        bytes = 0;
      phase.wrapper = {
        pid: running.child.pid,
        started_at: new Date().toISOString(),
        web_port: webPort,
        mcp_port: mcpPort,
      };
      running.child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 256 * 1024) output += decoder.write(chunk);
      });
      running.child.stderr.on('data', () => {});
      host.ready = async () => {
        await waitFor(
          () => {
            host.assertRunning();
            assert.ok(bytes <= 256 * 1024);
            return output.includes('DeviceForge 已启动');
          },
          Boolean,
          '真实npx就绪',
          20000,
        );
        assert.ok(output.includes('监听 0.0.0.0'));
        if (token) assert.ok(!output.includes(token));
        await client.json('/api/v2/health');
        phase.default_lan = true;
        phase.token_configured = Boolean(token);
        phase.wrapper.ready_at = new Date().toISOString();
      };
    },
    assertRunning: () => {
      assert.ok(running && !running.failure);
      assert.equal(running.child.exitCode, null);
      assert.equal(running.child.signalCode, null);
    },
    portsReleased: async () => {
      const entries = [],
        errors = [];
      for (const [role, port] of [
        ['http', webPort],
        ['mcp', mcpPort],
      ]) {
        try {
          await checkPort(port);
          entries.push({ role, port, released: true });
        } catch (error) {
          entries.push({
            role,
            port,
            released: false,
            error: { name: error.name, code: error.code },
          });
          errors.push(error);
        }
      }
      phase.ports = entries;
      if (errors.length) throw errors[0];
    },
    shutdown: async () => {
      host.assertRunning();
      const before = performance.now();
      await client.post('/api/v2/system/shutdown', undefined, {
        signal: AbortSignal.timeout(10000),
      });
      const ended = await waitForNpxExit(
        running,
        Math.max(0, 10000 - (performance.now() - before)),
      );
      phase.wrapper.shutdown_elapsed_ms = performance.now() - before;
      phase.wrapper.exit = ended ? { code: ended.code, signal: ended.signal } : null;
      assert.ok(ended);
      assert.equal(ended.failure, undefined);
      assert.deepEqual(phase.wrapper.exit, { code: 0, signal: null });
      await host.portsReleased();
      phase.wrapper.graceful_shutdown = true;
    },
    finish: async () => {
      if (!running || phase.wrapper.graceful_shutdown) return;
      const target = {
        url: base + '/api/v2/system/shutdown',
        webPort,
        mcpPort,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      };
      phase.failure_cleanup = await cleanupNpxRuntime({
        running,
        target,
        assertPortReleased: checkPort,
      });
      assert.equal(phase.failure_cleanup.passed, true, '自有npx退出或双端口清理未确认');
    },
  };
  return host;
}
