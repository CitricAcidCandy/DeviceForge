import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backend, deploy, host, object, pidAlive, suffix, type Host, type JsonObject } from './fixtures/six-business-support.ts';
import { identities, reporter } from './fixtures/ordinary-business-report.ts';
import { toolFeatureCases, toolFeatureSource, queryToolFeatureJobs, type ToolFeatureSource } from './fixtures/ordinary-tool-feature-cases.ts';

const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help')) {
  process.stdout.write('用法：node backend/tests/ordinary-tool-feature-smoke.ts [--release] [--bin-dir 绝对目录] [--rounds 1..10]\n');
} else {
  const profile = arguments_.includes('--release') ? 'release' : 'debug';
  let binDirectory = join(backend, 'target', profile); let rounds = 1;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]; if (argument === '--release') continue;
    const next = arguments_[++index]; assert.ok(next, '选项缺少值');
    if (argument === '--bin-dir') binDirectory = resolve(next);
    else if (argument === '--rounds') {
      rounds = Number(next); assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, '轮数须为1至10');
    } else throw new Error('未知驱动选项');
  }
  for (let round = 1; round <= rounds; round++) {
    const root = resolve(backend, '../artifacts', `ordinary-tool-feature-${profile}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await mkdir(root, { recursive: true }); const audit = await reporter(root, profile);
    audit.report.round = round; audit.report.scope = ['tool-supply.runtime_feature'];
    audit.report.matrix = 'runtime_feature';
    audit.report.evidence = '预构建真实宿主及工具供应插件、HTTP v2/MCP、合成文本ZIP；不执行SDK或真实工具、不连接外部来源';
    audit.report.remaining_gaps = ['真实发布来源、来源缓存回退、SDK实际执行与跨平台仍未验收',
      '本轮验证取消与原期限不改动，不宣称已覆盖自然到期或提交重命名失败；原独立专项证据不转计本轮'];
    const servers: Host[] = []; const stopped = new Set<Host>();
    const shutdowns: JsonObject[] = []; audit.report.shutdowns = shutdowns;
    const inputDirectories = [join(backend, 'plugins/tool-supply')];
    const inputFiles = [join(backend, 'Cargo.toml'), join(backend, 'Cargo.lock'),
      join(backend, 'docs/工具运行时功能迁移裁定.md'), join(backend, 'tests/ordinary-tool-feature-smoke.ts'),
      ...['six-business-support.ts', 'ordinary-business-source.ts', 'ordinary-business-report.ts', 'ordinary-tool-feature-cases.ts']
        .map((name) => join(backend, 'tests/fixtures', name)),
      ...['apk-server', 'deviceforge-tool-supply-plugin'].map((name) => join(binDirectory, name + suffix))];
    const installRoot = join(root, 'installed'); const privateBin = join(root, 'bin');
    let remote: ToolFeatureSource | undefined; let deployed: string[] = []; let success = false;
    const normalShutdown = async (running: Host, generation: number) => {
      const result = await running.close(); stopped.add(running);
      const record = { generation, ...result, pid_alive_after: typeof result.pid === 'number' ? pidAlive(result.pid) : null };
      shutdowns.push(record); await audit.flush();
      assert.equal(result.forced, false); assert.equal(result.shutdown_accepted, true);
      assert.equal(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.port_released, true);
      assert.equal(record.pid_alive_after, false);
    };
    const ready = async (running: Host) => {
      await running.ready(); const listed = await running.request('/api/v2/plugins');
      assert.equal(listed.response.status, 200); assert.ok(Array.isArray(listed.json)); assert.equal(listed.json.length, 1);
      const owner = object(listed.json[0]); assert.equal(owner.id, 'tool-supply');
      assert.equal(owner.state, 'loaded'); assert.equal(owner.cleanup_failed, false);
      assert.deepEqual(await running.mcp('deviceforge.list_plugins', {}), listed.json);
    };
    try {
      await audit.check('输入：本轮插件源码、公开清单、驱动及预构建二进制身份', async () => {
        audit.report.inputs_before = await identities(backend, inputDirectories, inputFiles);
      });
      remote = await toolFeatureSource(); const source = remote;
      audit.report.source_calls = source.calls; audit.report.source_faults = source.faults;
      audit.report.synthetic_inputs = source.inputs; audit.report.source_transitions = source.transitions;
      await audit.check('部署：隔离数据目录，仅使用真实工具供应插件与原执行预算', async () => {
        await mkdir(privateBin, { recursive: true }); await mkdir(join(root, 'browser-plugins'), { recursive: true });
        const serverPath = join(privateBin, `apk-server${suffix}`);
        await copyFile(join(binDirectory, `apk-server${suffix}`), serverPath);
        const deployment = await deploy(root, 'tool-supply', { manifest_url: `${source.base}/catalog`, install_root: installRoot,
          allow_http: true, manifest_cache_enabled: false,
          download_limit_bytes: 8388608, extracted_limit_bytes: 8388608, file_limit: 100 }, binDirectory);
        const manifest = object(deployment.manifest); assert.ok(Array.isArray(manifest.operations));
        const operations = manifest.operations.map(object);
        for (const name of ['runtime_feature.status', 'runtime_feature.prepare']) {
          const operation = operations.find((item) => item.name === name); assert.ok(operation, '预构建插件须包含新功能公开贡献');
          assert.equal(object(operation.input_schema).additionalProperties, false);
          assert.equal(object(operation.execution).total_timeout_ms, name.endsWith('status') ? 120000 : 900000);
        }
        deployed = [serverPath, join(deployment.directory, `deviceforge-tool-supply-plugin${suffix}`),
          join(deployment.directory, 'manifest.json'), join(deployment.directory, 'tool-supply.config.json')];
        audit.report.deployed_before = await identities(root, [], deployed);
      });
      const initial = await host(root, privateBin); servers.push(initial);
      await audit.check('宿主：初代真实启动、唯一插件与 HTTP/MCP 日志关联', async () => { await ready(initial); });
      const result = await toolFeatureCases(initial, source, audit, installRoot);
      await audit.check('宿主：初代正常 exit0、PID退出与端口释放', async () => { await normalShutdown(initial, 1); });
      audit.report.installed_before_recovery = await identities(root, [installRoot], []);
      const sourceCount = source.calls.length;
      const recovered = await host(root, privateBin); servers.push(recovered);
      await audit.check('宿主：同数据目录重启，仅加载插件不隐式下载', async () => {
        await ready(recovered); assert.equal(source.calls.length, sourceCount);
      });
      await audit.check('恢复：原成功、失败及取消 Job 共享查询、终态不变与零业务重提', async () => {
        await queryToolFeatureJobs(recovered, source, audit, result.jobs);
        audit.report.installed_after_recovery = await identities(root, [installRoot], []);
        assert.deepEqual(audit.report.installed_after_recovery, audit.report.installed_before_recovery);
        audit.report.installed_recovery_stable = true;
      });
      success = true;
    } catch (error) { audit.report.failure = audit.failure(error); }
    finally {
      for (const [index, running] of servers.entries()) {
        if (!stopped.has(running)) {
          try {
            await audit.check(`宿主：第${index + 1}代正常退出与端口释放`, async () => { await normalShutdown(running, index + 1); });
          } catch (error) { success = false; audit.report.shutdown_failure = audit.failure(error); }
        }
      }
      audit.report.requests = servers.flatMap((running, index) => running.requests.map((request) => ({ generation: index + 1, ...request })));
      if (remote) {
        try {
          await audit.check('合成源：无内部故障、连接收口及监听端口释放', async () => {
            const result = await remote!.close(); audit.report.source_shutdown = result;
            assert.equal(result.port_released, true); assert.equal(result.fault_count, 0); assert.equal(result.open_responses, 0);
          });
        } catch (error) { success = false; audit.report.source_shutdown_failure = audit.failure(error); }
      }
      if (deployed.length > 0) {
        try {
          await audit.check('部署：两个宿主代际前后副本、配置与清单原字节不变', async () => {
            audit.report.deployed_after = await identities(root, [], deployed);
            assert.deepEqual(audit.report.deployed_after, audit.report.deployed_before);
            audit.report.deployed_stable = true;
          });
        } catch (error) { success = false; audit.report.deployment_failure = audit.failure(error); }
      }
      try {
        await audit.check('输入：本轮源码、驱动与二进制前后身份稳定', async () => {
          audit.report.inputs_after = await identities(backend, inputDirectories, inputFiles);
          assert.deepEqual(audit.report.inputs_after, audit.report.inputs_before);
          audit.report.inputs_stable = true;
        });
      } catch (error) { success = false; audit.report.input_failure = audit.failure(error); }
      audit.report.passed = success; audit.report.finished_at = new Date().toISOString();
      await audit.flush();
      process.stdout.write(`${success ? '通过' : '失败'}：第${round}轮，报告 ${join(root, 'report.json')}\n`);
      if (!success) { process.exitCode = 1; break; }
    }
  }
}
