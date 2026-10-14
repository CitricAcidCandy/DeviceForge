// 验收脚本自身的失败回收：真实宿主接受任务并启动夹具后，破坏提交响应。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { installPlugin } from '../cli/src/install.mjs';
import { loadRuntime } from '../cli/src/runtime.mjs';
import { startWebServer } from '../cli/src/web-server.mjs';
import { configureOrdinaryNpx, verifyOrdinaryNpx } from './cli-smoke-ordinary.mjs';
import {
  pidAlive,
  poll,
  port,
  portReleased,
} from '../backend/tests/fixtures/six-business-support.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function pathEvidence(path) {
  const verbatim = path.startsWith('\\\\?\\');
  const ordinary =
    path.slice(0, 8).toUpperCase() === '\\\\?\\UNC\\'
      ? `\\\\${path.slice(8)}`
      : verbatim
        ? path.slice(4)
        : path;
  // JS 字符串长度按 UTF-16 码元计算；只保留长度和前缀标记，不输出配置路径。
  return { utf16_length: path.length, ordinary_utf16_length: ordinary.length, verbatim };
}
const mode = process.argv[2];
const deep = process.argv[3] === '--deep';
assert.ok(process.argv.length <= 4 && (!process.argv[3] || deep), '专项只接受报告目录及可选--deep');
if (!mode || mode === '--help') {
  console.log('用法：node scripts/cli-smoke-ordinary-failure.mjs <实际npx报告目录> [--deep]');
} else {
  const sourceRoot = resolve(mode);
  const directory = join(
    root,
    'artifacts',
    `ordinary-npx-submit-failure-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  const deployment = deep
    ? join(directory, 'deployment')
    : await mkdtemp(join(tmpdir(), 'deviceforge-ai-submit-'));
  const plugins = join(deployment, 'plugins');
  await mkdir(plugins, { recursive: true });
  const report = {
    scope: '真实宿主及保留原包；仅注入验收客户端响应故障，不证明npx启动或生产网络故障',
    started_at: new Date().toISOString(),
    path_mode: deep ? '工作区深目录' : '系统临时短目录',
    temporary_retained: deployment,
    passed: false,
    cases: [],
  };
  const paths = [
    'scripts/cli-smoke-ordinary.mjs',
    'scripts/cli-smoke-ordinary-failure.mjs',
    'cli/src/install.mjs',
    'cli/src/web-server.mjs',
    'backend/target/release/apk-server.exe',
    'backend/target/test-fixtures/ai-cli-fixture.exe',
  ];
  const inputs = async () =>
    Promise.all(
      paths.map(async (path) => {
        const bytes = await readFile(join(root, path));
        return { path, bytes: bytes.length, sha256: digest(bytes) };
      }),
    );
  const originalFetch = globalThis.fetch;
  let ordinary, child, closed, selected, mcpPort, mcpProxy;
  const token = randomUUID();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const flush = () =>
    writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  try {
    report.inputs_before = await inputs();
    const source = JSON.parse(await readFile(join(sourceRoot, 'report.json'), 'utf8'));
    assert.equal(source.passed, true);
    const runtime = await loadRuntime();
    report.archives = [];
    for (const id of ['settings', 'ai-assistant', 'tool-supply']) {
      const archive = source.native_archives.find((item) => item.id === id);
      assert.ok(archive);
      const bytes = await readFile(archive.path);
      assert.equal(bytes.length, archive.bytes);
      assert.equal(digest(bytes), archive.sha256);
      report.archives.push({ id, bytes: bytes.length, sha256: digest(bytes) });
      await installPlugin(
        { source: archive.path, dataDirectory: join(deployment, 'data') },
        { runtime, environment: { APK_PLUGIN_DIR: plugins } },
      );
    }
    ordinary = await configureOrdinaryNpx({
      root,
      temporary: deployment,
      pluginDirectory: plugins,
    });
    report.configuration = ordinary.evidence;
    const fixtureRoot = dirname(join(plugins, ordinary.evidence.ai_fixture.deployed.path));
    selected = await port();
    mcpPort = await port();
    assert.notEqual(selected, mcpPort);
    const base = `http://127.0.0.1:${selected}`;
    const mcp = `http://127.0.0.1:${mcpPort}/mcp`;
    mcpProxy = await startWebServer({
      port: mcpPort,
      backendPort: selected,
      ip: '127.0.0.1',
      allowedHosts: [`127.0.0.1:${mcpPort}`],
      mcpOnly: true,
    });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
    );
    Object.assign(environment, {
      APK_BIND: `127.0.0.1:${selected}`,
      APK_API_TOKEN: token,
      APK_PLUGIN_DIR: plugins,
      APK_DATA_DIR: join(deployment, 'data'),
      APK_BROWSER_PLUGIN_DIR: join(deployment, 'browser-plugins'),
      DEVICEFORGE_HTTP_RATE: '10000',
      APK_MCP_HOSTS: `127.0.0.1:${selected}`,
      APK_MCP_ORIGINS: base,
    });
    await mkdir(environment.APK_BROWSER_PLUGIN_DIR);
    child = spawn(join(root, 'backend/target/release/apk-server.exe'), [], {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    report.host = { pid: child.pid, stderr_bytes: 0 };
    child.stderr.on('data', (bytes) => {
      report.host.stderr_bytes += bytes.length;
    });
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
    await poll(
      async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error('专项宿主提前退出');
        try {
          return (
            await originalFetch(`${base}/api/v2/health`, {
              headers,
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      Boolean,
      '专项宿主就绪',
    );
    for (const [index, fault] of ['missing_log_header', 'invalid_json'].entries()) {
      const entry = { fault, injection_count: 0, passed: false };
      report.cases.push(entry);
      const call = join(fixtureRoot, `call-${String(index + 1).padStart(2, '0')}`);
      globalThis.fetch = async (resource, options) => {
        const response = await originalFetch(resource, options);
        if (
          entry.injection_count ||
          options?.method !== 'POST' ||
          new URL(resource).pathname !== '/api/v2/jobs'
        )
          return response;
        const body = JSON.parse(options.body);
        if (body.operation !== 'plugin.ai-assistant.cli.turn') return response;
        assert.equal(response.status, 202);
        const accepted = await response.clone().json();
        entry.job_id = accepted.data.id;
        await poll(
          async () => {
            try {
              return await readFile(join(call, 'ready'), 'utf8');
            } catch {
              return null;
            }
          },
          (ready) => ready === '1',
          '注入前实际CLI就绪',
        );
        entry.ready_before_injection = true;
        entry.injection_count++;
        const bytes = await response.arrayBuffer();
        const modified = new Headers(response.headers);
        if (fault === 'missing_log_header') modified.delete('x-deviceforge-log-id');
        return new Response(fault === 'invalid_json' ? '{' : bytes, {
          status: response.status,
          headers: modified,
        });
      };
      let failed;
      try {
        await verifyOrdinaryNpx({ base, mcp, headers, ordinary });
      } catch (error) {
        failed = error.ordinaryBusinessEvidence;
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.ok(failed);
      assert.equal(failed.passed, false);
      entry.helper_failure = failed;
      try {
        const configuration = ordinary.evidence.configurations.find(
          (item) => item.id === 'ai-assistant',
        );
        const bytes = await readFile(join(plugins, configuration.path));
        const { state_root: stateRoot } = JSON.parse(bytes.toString('utf8'));
        const threads = join(stateRoot, 'threads');
        entry.ai_state_paths = {
          available: true,
          configuration_sha256: digest(bytes),
          threads: pathEvidence(threads),
          json: pathEvidence(join(threads, `${failed.namespace.thread_id}.json`)),
        };
      } catch (error) {
        // 证据读取异常仅保留摘要，不覆盖原故障或改变业务通过条件。
        entry.ai_state_paths = {
          available: false,
          failure: {
            name: error.name,
            code: error.code ?? null,
            message_sha256: digest(String(error.message)),
          },
        };
      }
      assert.equal(failed.ai_tools.length, 1);
      assert.equal(failed.ai_tools[0].release_written, true);
      assert.equal(await readFile(join(fixtureRoot, `release-${index + 1}`), 'utf8'), '1');
      const pid = Number(await readFile(join(call, 'pid'), 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      await poll(
        async () => pidAlive(pid),
        (alive) => !alive,
        '故障后CLI实际退出',
      );
      assert.equal(await readFile(join(call, 'normal-exit'), 'utf8'), '0');
      entry.cli = { pid, exited: true, normal_exit: 0, released_before_host_shutdown: true };
      const job = await poll(
        async () => {
          const reply = await originalFetch(`${base}/api/v2/jobs/${entry.job_id}`, {
            headers,
            signal: AbortSignal.timeout(3000),
          });
          assert.equal(reply.status, 200);
          return (await reply.json()).data;
        },
        (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status),
        '已接受任务真实终态',
      );
      entry.job_status = job.status;
      entry.error_sha256 = job.error == null ? null : digest(String(job.error));
      assert.equal(job.status, 'succeeded');
      const rpc = await originalFetch(mcp, {
        method: 'POST',
        headers: { ...headers, accept: 'application/json, text/event-stream' },
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: index + 1,
          method: 'tools/call',
          params: { name: 'deviceforge.get_job', arguments: { id: entry.job_id } },
        }),
      });
      assert.equal(rpc.status, 200);
      const other = await rpc.json();
      assert.equal(other.result.isError, false);
      assert.equal(
        other.result._meta['deviceforge/log_id'],
        rpc.headers.get('x-deviceforge-log-id'),
      );
      assert.deepEqual(other.result.structuredContent, job);
      entry.shared_job = true;
      entry.passed = true;
      await flush();
    }
    report.passed = true;
  } catch (error) {
    report.failure = {
      name: error.name,
      code: error.code ?? null,
      message_sha256: digest(String(error.message)),
      driver_line: error.stack?.match(/cli-smoke-ordinary-failure\.mjs:(\d+)/)?.[1] ?? null,
    };
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    // 故障与成功均保留本轮目录；先核对夹具退出，再关闭宿主。
    if (child && closed) {
      let forced = false,
        accepted = false;
      if (child.exitCode === null) {
        try {
          const response = await originalFetch(
            `http://127.0.0.1:${selected}/api/v2/system/shutdown`,
            { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(3000) },
          );
          accepted = response.status === 200 && (await response.json()).data.stopping === true;
        } catch {
          /* 清理结论独立保留，不能覆盖原故障摘要。 */
        }
        if (!(await Promise.race([closed, delay(12000).then(() => null)]))) {
          forced = true;
          child.kill('SIGKILL');
        }
      }
      const exit = await Promise.race([closed, delay(5000).then(() => null)]);
      report.shutdown = { ...exit, accepted, forced, port_released: await portReleased(selected) };
      if (!accepted || forced || exit?.code !== 0 || !report.shutdown.port_released)
        report.passed = false;
    }
    if (mcpProxy) {
      try {
        await mcpProxy.close();
        report.mcp_port_released = await portReleased(mcpPort);
        assert.equal(report.mcp_port_released, true);
      } catch {
        report.passed = false;
        report.mcp_port_released = false;
      }
    }
    if (ordinary) {
      try {
        await ordinary.close();
        assert.equal(ordinary.evidence.source_port_released, true);
      } catch (error) {
        report.passed = false;
        report.source_close_failure = { name: error.name, code: error.code ?? null };
      }
    }
    try {
      report.inputs_after = await inputs();
      assert.deepEqual(report.inputs_after, report.inputs_before);
      report.inputs_stable = true;
    } catch {
      report.passed = false;
      report.inputs_stable = false;
    }
    report.finished_at = new Date().toISOString();
    await flush();
    if (!report.passed) process.exitCode = 1;
    console.log(
      `${report.passed ? '通过' : '失败'}：AI提交响应故障回收，报告 ${join(directory, 'report.json')}`,
    );
  }
}
