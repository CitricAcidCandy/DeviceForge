import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backend, deploy, host, object, pidAlive, suffix, type Host, type JsonObject } from './fixtures/six-business-support.ts';
import { identities, reporter } from './fixtures/ordinary-business-report.ts';
import { toolCacheSource, type ToolCacheSource } from './fixtures/ordinary-tool-cache-source.ts';
import { cacheLoaded, toolCacheARecovery, toolCacheCases, toolCacheSeed, type CacheLedger } from './fixtures/ordinary-tool-cache-cases.ts';
import { cacheTerminal, persistedEvidence } from './fixtures/ordinary-tool-cache-evidence.ts';

const options = process.argv.slice(2);
if (options.includes('--help')) {
  process.stdout.write('用法：node backend/tests/ordinary-tool-cache-smoke.ts [--release] [--bin-dir 绝对目录] [--rounds 1..10]\n每轮保留独立报告及原件；HTTP/MCP各等待原120秒自然到期，不构建。\n');
} else {
  const profile = options.includes('--release') ? 'release' : 'debug';
  let binDirectory = join(backend, 'target', profile); let rounds = 1;
  for (let index = 0; index < options.length; index++) {
    const option = options[index]; if (option === '--release') continue;
    const next = options[++index]; assert.ok(next, '选项缺少值');
    if (option === '--bin-dir') binDirectory = resolve(next);
    else if (option === '--rounds') { rounds = Number(next); assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10); }
    else throw new Error('未知缓存驱动选项');
  }
  for (let round = 1; round <= rounds; round++) {
    const root = resolve(backend, '../artifacts', `ordinary-tool-cache-${profile}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await mkdir(root, { recursive: true }); const audit = await reporter(root, profile);
    audit.report.round = round; audit.report.scope = ['tool-supply.manifest_cache'];
    audit.report.evidence = '预构建真实宿主/插件、HTTP v2/MCP与只含文本的合成ZIP；原预算、缓存封装/SQLite/宿主日志原件保留';
    audit.report.remaining_gaps = ['未独立重算Rust确定性序列化的canonical摘要；原JSON响应哈希不是manifest_sha256，封装原件与跨任务摘要/模块输入另行核验',
      '缓存IO/Busy/原子提交与清理失败、来源切换、并发原子读写和旧install锁序未纳入本批服务矩阵',
      '缓存关闭/local_manifest、DNS/TLS/正文超限未纳入；真实来源、SDK执行、跨平台与npx另行验收'];
    const inputFiles = [join(backend, 'Cargo.toml'), join(backend, 'Cargo.lock'), join(backend, 'docs/工具来源缓存回退裁定.md'),
      join(backend, 'docs/工具运行时功能迁移裁定.md'), join(backend, 'tests/ordinary-tool-cache-smoke.ts'),
      ...['six-business-support.ts', 'ordinary-business-source.ts', 'ordinary-business-report.ts',
        'ordinary-tool-cache-source.ts', 'ordinary-tool-cache-evidence.ts', 'ordinary-tool-cache-cases.ts', 'ordinary-tool-cache-README.md']
        .map((name) => join(backend, 'tests/fixtures', name)),
      ...['apk-server', 'deviceforge-tool-supply-plugin'].map((name) => join(binDirectory, name + suffix))];
    const inputDirectories = [join(backend, 'plugins/tool-supply')];
    type ServerRecord = { running: Host; directory: string; transport: string; generation: number };
    const servers: ServerRecord[] = [];
    const stopped = new Set<Host>(); const sources: { source: ToolCacheSource; transport: string }[] = [];
    const deployments: string[] = []; const shutdowns: JsonObject[] = []; const scenarios: JsonObject[] = [];
    audit.report.shutdowns = shutdowns; audit.report.cache_scenarios = scenarios;
    const normalClose = async (record: ServerRecord) => {
      const result = await record.running.close(); stopped.add(record.running);
      const shutdown = { transport: record.transport, generation: record.generation, ...result,
        pid_alive_after: typeof result.pid === 'number' ? pidAlive(result.pid) : null };
      shutdowns.push(shutdown); await audit.flush();
      assert.equal(result.forced, false); assert.equal(result.shutdown_accepted, true);
      assert.equal(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.port_released, true);
      assert.equal(shutdown.pid_alive_after, false);
    };
    let success = false;
    try {
      await audit.check('输入：新缓存驱动、插件源码/公开契约与预构建二进制摘要', async () => {
        audit.report.inputs_before = await identities(backend, inputDirectories, inputFiles);
      });
      for (const viaMcp of [false, true]) {
        const transport = viaMcp ? 'mcp' : 'http'; const directory = join(root, transport);
        const installRoot = join(directory, 'installed'); const privateBin = join(directory, 'bin');
        const source = await toolCacheSource(directory); sources.push({ source, transport });
        const ledger: CacheLedger = { jobs: [], submissions: [], links: [], cases: [] };
        const scenario: JsonObject = { transport, directory: transport, source_calls: source.calls, source_faults: source.faults,
          synthetic_inputs: source.inputs, terminal_jobs: ledger.jobs, submissions: ledger.submissions, job_links: ledger.links, cases: ledger.cases };
        scenarios.push(scenario); await audit.flush();
        await audit.check(`部署 ${transport}：仅真实工具插件、默认启用缓存与原预算`, async () => {
          await mkdir(privateBin, { recursive: true }); await mkdir(join(directory, 'browser-plugins'), { recursive: true });
          const executable = join(privateBin, `apk-server${suffix}`); await copyFile(join(binDirectory, `apk-server${suffix}`), executable);
          const deployment = await deploy(directory, 'tool-supply', { manifest_url: source.base + '/catalog', install_root: installRoot,
            allow_http: true, download_limit_bytes: 8388608, extracted_limit_bytes: 8388608, file_limit: 100 }, binDirectory);
          const manifest = object(deployment.manifest); assert.ok(Array.isArray(manifest.operations));
          const operations = manifest.operations.map(object);
          for (const name of ['catalog', 'plan', 'install', 'runtime_feature.status', 'runtime_feature.prepare', 'remove']) {
            const operation = operations.find((item: JsonObject) => item.name === name); assert.ok(operation);
            assert.equal(object(operation.input_schema).additionalProperties, false);
            assert.equal(object(operation.execution).total_timeout_ms, ['install', 'runtime_feature.prepare'].includes(name) ? 900000 : 120000);
          }
          const files = [executable, join(deployment.directory, `deviceforge-tool-supply-plugin${suffix}`),
            join(deployment.directory, 'manifest.json'), join(deployment.directory, 'tool-supply.config.json')];
          deployments.push(...files); scenario.deployed_before = await identities(root, [], files);
        });
        const start = async (generation: number) => {
          const running = await host(directory, privateBin); const record = { running, directory, transport, generation }; servers.push(record);
          await audit.check(`宿主 ${transport}：第${generation}代真实启动与公开插件状态`, async () => { await running.ready(); await cacheLoaded(running); });
          return record;
        };
        const first = await start(1); const seed = await toolCacheSeed(first.running, source, audit, ledger, directory, installRoot, viaMcp);
        await audit.check(`宿主 ${transport}：初代正常退出、PID与端口释放`, async () => { await normalClose(first); });
        const beforeRestart = source.calls.length; const second = await start(2);
        assert.equal(source.calls.length, beforeRestart, '重启不能隐式读取来源');
        await toolCacheARecovery(second.running, source, audit, ledger, installRoot, seed);
        const completed = await toolCacheCases(second.running, source, audit, ledger, directory, installRoot, seed);
        scenario.manifest_sha256_A = seed.digestA; scenario.manifest_sha256_B = completed.digestB;
        scenario.snapshot_B = completed.snapshotB.evidence;
        await audit.check(`宿主 ${transport}：第二代正常退出、PID与端口释放`, async () => { await normalClose(second); });
        const installedBefore = await identities(directory, [installRoot], []); const beforeQueries = source.calls.length;
        const recovered = await start(3); const queries: JsonObject[] = [];
        await audit.check(`恢复 ${transport}：仅查询全部原Job、终态/摘要不变且不重提`, async () => {
          scenario.recovered_queries = queries;
          for (const expected of ledger.jobs) {
            const actual = cacheTerminal(await recovered.running.shared(expected.id)); queries.push(actual); await audit.flush();
            assert.deepEqual(actual, expected);
          }
          assert.equal(source.calls.length, beforeQueries);
          assert.deepEqual(await identities(directory, [installRoot], []), installedBefore); scenario.recovery_zero_source_calls = true;
        });
        await audit.check(`宿主 ${transport}：恢复代正常退出、PID与端口释放`, async () => { await normalClose(recovered); });
        await audit.check(`原件 ${transport}：SQLite终态与日志提交/插件调用身份独立核验`, async () => {
          scenario.persisted = await persistedEvidence(directory, ledger.jobs, ledger.submissions);
          scenario.final_install_inputs = await identities(directory, [installRoot], []);
        });
      }
      success = true;
    } catch (error) { audit.report.failure = audit.failure(error); }
    finally {
      for (const record of servers) {
        if (!stopped.has(record.running)) {
          try { await audit.check(`收口 ${record.transport}：第${record.generation}代正常退出`, async () => { await normalClose(record); }); }
          catch (error) { success = false; audit.report.shutdown_failure = audit.failure(error); }
        }
      }
      audit.report.requests = servers.flatMap((record) => record.running.requests.map((request) => ({ transport_scenario: record.transport, generation: record.generation, ...request })));
      for (const record of sources) {
        try {
          await audit.check(`合成来源 ${record.transport}：连接与端口释放、无内部故障`, async () => {
            const result = await record.source.close(); const scenario = scenarios.find((item) => item.transport === record.transport);
            assert.ok(scenario); scenario.source_shutdown = result; await audit.flush();
            assert.equal(result.port_released, true); assert.equal(result.fault_count, 0); assert.equal(result.open_responses, 0);
          });
        } catch (error) { success = false; audit.report.source_shutdown_failure = audit.failure(error); }
      }
      try {
        await audit.check('部署：隔离副本及配置前后身份', async () => {
          audit.report.deployed_after = await identities(root, [], deployments);
          const before = scenarios.flatMap((scenario) => { assert.ok(Array.isArray(scenario.deployed_before)); return scenario.deployed_before; });
          before.sort((left, right) => String(object(left).path).localeCompare(String(object(right).path)));
          const after = object({ items: audit.report.deployed_after }).items; assert.ok(Array.isArray(after));
          after.sort((left, right) => String(object(left).path).localeCompare(String(object(right).path)));
          assert.deepEqual(after, before); audit.report.deployed_stable = true;
        });
        await audit.check('输入：源码、驱动与二进制摘要前后不变', async () => {
          audit.report.inputs_after = await identities(backend, inputDirectories, inputFiles);
          assert.deepEqual(audit.report.inputs_after, audit.report.inputs_before); audit.report.inputs_stable = true;
        });
      } catch (error) { success = false; audit.report.identity_failure = audit.failure(error); }
      audit.report.passed = success; audit.report.finished_at = new Date().toISOString();
      await audit.flush(); process.stdout.write(`${success ? '通过' : '失败'}：第${round}轮 ${join(root, 'report.json')}\n`);
      if (!success) { process.exitCode = 1; break; }
    }
  }
}
