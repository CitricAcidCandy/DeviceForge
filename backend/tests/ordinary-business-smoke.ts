// 三个普通插件的真实 HTTP/MCP 验收入口；主代理预构建后执行，驱动不调用 Cargo/rustc。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backend, deploy, host, object, suffix, tool, type Host } from './fixtures/six-business-support.ts';
import { source } from './fixtures/ordinary-business-source.ts';
import { identities, reporter } from './fixtures/ordinary-business-report.ts';
import { settingsCases } from './fixtures/ordinary-settings-cases.ts';
import { aiCases } from './fixtures/ordinary-ai-cases.ts';
import { supplyCases } from './fixtures/ordinary-supply-cases.ts';

const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help')) {
  process.stdout.write('用法：node backend/tests/ordinary-business-smoke.ts [--extended] [--release] [--bin-dir 绝对目录] [--ai-fixture 绝对路径] [--rounds 1..10]\n');
} else {
  const profile = arguments_.includes('--release') ? 'release' : 'debug';
  const extended = arguments_.includes('--extended');
  let binDirectory = join(backend, 'target', profile);
  let fixture = join(backend, 'target/test-fixtures', `ai-cli-fixture${suffix}`); let rounds = 1;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]; if (argument === '--release' || argument === '--extended') continue;
    const next = arguments_[++index]; assert.ok(next, '选项缺少值');
    if (argument === '--bin-dir') binDirectory = resolve(next);
    else if (argument === '--ai-fixture') fixture = resolve(next);
    else if (argument === '--rounds') { rounds = Number(next); assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10); }
    else throw new Error('未知驱动选项');
  }
  for (let round = 1; round <= rounds; round++) {
    const root = join(backend, '../artifacts', `ordinary-business-${profile}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await mkdir(root, { recursive: true }); const audit = await reporter(root, profile);
    audit.report.round = round;
    audit.report.matrix = extended ? 'extended' : 'basic';
    audit.report.remaining_gaps = ['真实模型及外部配置服务、发布工具不在合成验收范围', '工具供应重命名提交失败后 backup 恢复已有 Windows 独立专项证据，不计为本矩阵覆盖；其他平台及文件系统仍未验证'];
    let server: Host | undefined; let remote: Awaited<ReturnType<typeof source>> | undefined;
    const inputDirectories = ['settings', 'ai-assistant', 'tool-supply'].map((id) => join(backend, 'plugins', id));
    const inputFiles = [join(backend, 'Cargo.toml'), join(backend, 'Cargo.lock'),
      join(backend, 'tests/ordinary-business-smoke.ts'),
      ...['six-business-support.ts', 'ordinary-business-source.ts', 'ordinary-business-report.ts', 'ordinary-settings-cases.ts', 'ordinary-settings-backup-cases.ts', 'ordinary-ai-cases.ts', 'ordinary-supply-cases.ts', 'ai-cli-fixture.rs'].map((name) => join(backend, 'tests/fixtures', name)),
      ...['apk-server', 'deviceforge-settings-plugin', 'deviceforge-ai-assistant-plugin', 'deviceforge-tool-supply-plugin'].map((name) => join(binDirectory, name + suffix)), fixture];
    let success = false;
    try {
      await audit.check('输入：三插件源码、清单、驱动及预构建二进制身份', async () => {
        audit.report.inputs_before = await identities(backend, inputDirectories, inputFiles);
      });
      remote = await source();
      const cli = await tool(root, 'ai-cli', fixture);
      const settingsRoot = join(root, 'settings'); const installRoot = join(root, 'installed');
      const project = join(root, 'projects/fixture'); const otherProject = join(root, 'projects/other');
      await mkdir(project, { recursive: true }); await mkdir(otherProject, { recursive: true });
      await mkdir(join(root, 'browser-plugins'), { recursive: true });
      await deploy(root, 'settings', { format_version: 1, storage_root: settingsRoot,
        remote: { base_url: `${remote.base}/`, headers: { 'x-fixture-key': 'synthetic-remote-key' } } }, binDirectory);
      await deploy(root, 'ai-assistant', { format_version: 1, executable: cli.executable, args: ['--fixture'],
        projects: { fixture: project, other: otherProject }, environment: {}, state_root: join(root, 'ai-state') }, binDirectory);
      await deploy(root, 'tool-supply', { manifest_url: `${remote.base}/catalog`, install_root: installRoot,
        allow_http: true, download_limit_bytes: 8388608, extracted_limit_bytes: 8388608, file_limit: 100 }, binDirectory);
      audit.report.deployed = await identities(root, [], ['settings', 'ai-assistant', 'tool-supply'].flatMap((id) => [
        join(root, 'plugins', id, 'manifest.json'), join(root, 'plugins', id, `deviceforge-${id}-plugin${suffix}`),
        join(root, 'plugins', id, `${id}.config.json`),
      ]).concat(cli.executable));
      server = await host(root, binDirectory); const running = server;
      await audit.check('宿主：隔离三插件启动及 HTTP/MCP 目录一致', async () => {
        await running.ready(); const response = await running.request('/api/v2/plugins'); assert.equal(response.response.status, 200);
        const plugins = response.json as unknown[]; assert.ok(Array.isArray(plugins));
        assert.deepEqual(plugins.map((plugin) => object(plugin).id).sort(), ['ai-assistant', 'settings', 'tool-supply']);
        assert.deepEqual(await running.mcp('deviceforge.list_plugins', {}), plugins);
      });
      // 基础业务先执行；每个检查失败立即冻结该轮，保留全部已完成证据。
      await settingsCases(running, remote, audit, settingsRoot, extended);
      await aiCases(running, cli, audit, extended);
      await supplyCases(running, remote, audit, installRoot, extended);
      await audit.check('宿主：三插件均可排空卸载', async () => {
        for (const [index, id] of ['settings', 'ai-assistant', 'tool-supply'].entries()) await running.manage(id, 'unload', index % 2 === 0);
      });
      success = true;
    } catch (error) { audit.report.failure = audit.failure(error); }
    finally {
      if (server) {
        try {
          await audit.check('宿主：正常退出码零与端口释放', async () => {
            const stopped = await server!.close(); audit.report.shutdown = stopped;
            assert.equal(stopped.forced, false); assert.equal(stopped.shutdown_accepted, true);
            assert.equal(stopped.exitCode, 0); assert.equal(stopped.signal, null); assert.equal(stopped.port_released, true);
          });
        } catch (error) { success = false; audit.report.shutdown_failure = audit.failure(error); }
        audit.report.requests = server.requests;
      }
      if (remote) {
        audit.report.source_calls = remote.calls;
        try { await remote.close(); } catch (error) { success = false; audit.report.source_close_failure = audit.failure(error); }
      }
      try {
        await audit.check('输入：整轮前后字节身份保持不变', async () => {
          audit.report.inputs_after = await identities(backend, inputDirectories, inputFiles);
          assert.deepEqual(audit.report.inputs_after, audit.report.inputs_before, '生产输入或二进制在验收期间变更');
          audit.report.inputs_stable = true;
        });
      } catch (error) { success = false; audit.report.input_failure = audit.failure(error); }
      audit.report.passed = success; audit.report.finished_at = new Date().toISOString(); await audit.flush();
      process.stdout.write(`${success ? '通过' : '失败'}：第 ${round} 轮，报告 ${join(root, 'report.json')}\n`);
      if (!success) { process.exitCode = 1; break; }
    }
  }
}
