// 独立配置提交未知验收：主代理预构建 apk-server/settings 后运行，不调用 Cargo/rustc。
// backend 目录命令：node tests/settings-commit-uncertainty-smoke.ts；发布追加 --release。
// 门闩仅证明合成旧服务已写入，不能证明插件收到成功响应后再取消；该窗口保持缺口。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backend, deploy, host, object, suffix, type Host } from './fixtures/six-business-support.ts';
import { identities, reporter } from './fixtures/ordinary-business-report.ts';
import { commitSource, type CommitSource } from './fixtures/settings-commit-uncertainty-source.ts';
import { commitCases } from './fixtures/settings-commit-uncertainty-cases.ts';

// 交接时冻结当前公开辅助；若主代理后续修改辅助，重新静态核验后更新本批摘要。
const dependencyDigests: Record<string, string> = {
  'tests/fixtures/six-business-support.ts': '70a445f6d5c2fbbabfaaa41dfa6ecf4d9261717591462cf65937b8e5741fd5ca',
  'tests/fixtures/ordinary-business-report.ts': 'b28f254a7a25f3c8f8cff14a0ce41010f5e0cbf723fac262de685380d7023ea4',
};
const parameters = process.argv.slice(2);
if (parameters.includes('--help')) {
  process.stdout.write('用法：node tests/settings-commit-uncertainty-smoke.ts [--release] [--bin-dir 预构建目录] [--rounds 1..10]\n');
} else {
  const profile = parameters.includes('--release') ? 'release' : 'debug';
  let binDirectory = join(backend, 'target', profile); let rounds = 1;
  for (let index = 0; index < parameters.length; index++) {
    const flag = parameters[index]; if (flag === '--release') continue;
    const next = parameters[++index]; assert.ok(next, '选项缺少值');
    if (flag === '--bin-dir') binDirectory = resolve(next);
    else if (flag === '--rounds') { rounds = Number(next); assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, '轮次范围无效'); }
    else throw new Error('未知驱动选项');
  }
  for (let round = 1; round <= rounds; round++) {
    const root = join(backend, '../artifacts', `settings-commit-uncertainty-${profile}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await mkdir(root, { recursive: true }); const audit = await reporter(root, profile);
    audit.report.scope = ['settings']; audit.report.round = round;
    audit.report.evidence = '真实 Rust 宿主/settings 插件与本地合成旧配置服务；验证远端已写入但调用方提交结果未知';
    audit.report.scenarios = [];
    audit.report.remaining_gaps = ['当前门闩不证明插件已收到并解析完整成功响应后才取消；不制造该时间窗口', '合成旧服务状态不代表真实外部服务或分布式回滚保证'];
    const scripts = [join(backend, 'tests/settings-commit-uncertainty-smoke.ts'),
      join(backend, 'tests/fixtures/settings-commit-uncertainty-source.ts'), join(backend, 'tests/fixtures/settings-commit-uncertainty-cases.ts')];
    const dependencies = [join(backend, 'tests/fixtures/six-business-support.ts'), join(backend, 'tests/fixtures/ordinary-business-report.ts')];
    const inputFiles = [...scripts, ...dependencies, join(backend, 'Cargo.toml'), join(backend, 'Cargo.lock'),
      join(binDirectory, `apk-server${suffix}`), join(binDirectory, `deviceforge-settings-plugin${suffix}`)];
    const directories = [join(backend, 'plugins/settings')];
    let server: Host | undefined; let remote: CommitSource | undefined; let success = false;
    let deployedFiles: string[] = []; let copiedHostFiles: string[] = [];
    try {
      await audit.check('输入：新增驱动、当前共享依赖、settings 源码与预构建身份', async () => {
        audit.report.inputs_before = await identities(backend, directories, inputFiles);
        const frozenDependencies = await identities(backend, [], dependencies);
        audit.report.dependencies = frozenDependencies;
        for (const dependency of frozenDependencies) assert.equal(dependency.sha256, dependencyDigests[dependency.path], '共享依赖与本批交接版本不一致');
      });
      const privateBin = join(root, 'bin'); await mkdir(privateBin);
      for (const name of ['apk-server', 'deviceforge-settings-plugin']) {
        const target = join(privateBin, name + suffix);
        await copyFile(join(binDirectory, name + suffix), target); copiedHostFiles.push(target);
      }
      remote = await commitSource(); const source = remote;
      const storage = join(root, 'settings');
      await mkdir(join(root, 'browser-plugins'), { recursive: true });
      const deployment = await deploy(root, 'settings', { format_version: 1, storage_root: storage,
        remote: { base_url: `${source.base}/`, headers: {} } }, privateBin);
      deployedFiles = [join(deployment.directory, 'manifest.json'), join(deployment.directory, `settings.config.json`),
        join(deployment.directory, `deviceforge-settings-plugin${suffix}`), ...copiedHostFiles];
      audit.report.deployed_before = await identities(root, [], deployedFiles);
      server = await host(root, privateBin); const running = server;
      await audit.check('宿主：只有 settings 部署、v2/MCP 日志关联及目录一致', async () => {
        await running.ready(); const reply = await running.request('/api/v2/plugins'); assert.equal(reply.response.status, 200);
        assert.ok(Array.isArray(reply.json)); assert.deepEqual(reply.json.map((plugin: unknown) => object(plugin).id), ['settings']);
        assert.deepEqual(await running.mcp('deviceforge.list_plugins', {}), reply.json);
      });
      await commitCases(running, source, audit, storage);
      await audit.check('远端：三个独立情景合计仅三次 POST', async () => {
        assert.equal(source.writes.length, 3); assert.deepEqual(source.faults, []);
        assert.ok(source.writes.every((write) => write.ordinal === 1 && write.response_closed));
      });
      success = true;
    } catch (error) { audit.report.failure = audit.failure(error); }
    finally {
      if (server) {
        try {
          await audit.check('宿主：正常 exit0、没有强制退出、端口可重新绑定', async () => {
            const shutdown = await server!.close(); audit.report.shutdown = shutdown;
            assert.equal(shutdown.forced, false); assert.equal(shutdown.shutdown_accepted, true);
            assert.equal(shutdown.exitCode, 0); assert.equal(shutdown.signal, null); assert.equal(shutdown.port_released, true);
          });
        } catch (error) { success = false; audit.report.shutdown_failure = audit.failure(error); }
        audit.report.requests = server.requests;
      }
      if (remote) {
        // 所有正文留在内存，失败只保留受限摘要、计数及事件次序。
        audit.report.source_calls = remote.writes.map((write) => ({ ...write }));
        audit.report.source_reads = remote.reads.map((read) => ({ ...read }));
        audit.report.source_faults = [...remote.faults];
        try {
          await audit.check('合成旧服务：连接排空及监听端口释放', async () => {
            const stopped = await remote!.close(); audit.report.source_shutdown = stopped;
            assert.equal(stopped.port_released, true); assert.equal(stopped.faults, 0);
          });
        } catch (error) { success = false; audit.report.source_shutdown_failure = audit.failure(error); }
      }
      try {
        await audit.check('输入：原件、共享依赖及隔离部署副本前后身份不变', async () => {
          audit.report.inputs_after = await identities(backend, directories, inputFiles);
          assert.deepEqual(audit.report.inputs_after, audit.report.inputs_before);
          if (deployedFiles.length > 0) {
            audit.report.deployed_after = await identities(root, [], deployedFiles);
            assert.deepEqual(audit.report.deployed_after, audit.report.deployed_before);
          }
          audit.report.inputs_stable = true;
        });
      } catch (error) { success = false; audit.report.input_failure = audit.failure(error); }
      audit.report.passed = success; audit.report.finished_at = new Date().toISOString();
      try { await audit.flush(); }
      catch (error) {
        success = false; audit.report.passed = false; audit.report.final_publish_failure = audit.failure(error);
        // 共享 reporter 的有界发布重试耗尽后保留现有 JSON/tmp，不覆盖成通过。
        try {
          await writeFile(join(root, 'final-publication-failure.json'), JSON.stringify({ passed: false, exit_code: 1,
            failure: audit.report.final_publish_failure, at: new Date().toISOString() }, null, 2), { encoding: 'utf8', flag: 'wx' });
        } catch { /* 不再重试或删除已发布证据，进程退出码保持失败。 */ }
        process.stdout.write(`报告发布失败：第 ${round} 轮；保留目录 ${root}\n`);
      }
      process.stdout.write(`${success ? '通过' : '失败'}：第 ${round} 轮；报告 ${join(root, 'report.json')}\n`);
      if (!success) { process.exitCode = 1; break; }
    }
  }
}
