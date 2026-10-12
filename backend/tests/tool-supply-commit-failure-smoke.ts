// 独立提交 rename 失败验收；只消费主代理预构建二进制，不调用 Cargo/rustc 或共享门禁。
// 根目录：node backend/tests/tool-supply-commit-failure-smoke.ts [--release]；--probe-only 只运行隔离 NTFS 探针。
// 局部拒绝 DELETE/FILE_DELETE_CHILD 必须先探针通过；清理失败不记 cleaned，人工回收只限本轮事务。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { backend, deploy, host, object, suffix, type Host } from './fixtures/six-business-support.ts';
import { identities, reporter } from './fixtures/ordinary-business-report.ts';
import { commitSource, packages, type CommitSource } from './fixtures/tool-supply-commit-source.ts';
import { commitCases, normalShutdown, ntfsProbe } from './fixtures/tool-supply-commit-cases.ts';

const dependencyDigests: Record<string, string> = {
  'tests/fixtures/six-business-support.ts': '70a445f6d5c2fbbabfaaa41dfa6ecf4d9261717591462cf65937b8e5741fd5ca',
  'tests/fixtures/ordinary-business-report.ts': 'b28f254a7a25f3c8f8cff14a0ce41010f5e0cbf723fac262de685380d7023ea4',
};
async function resolveShell(name: string) {
  const candidates = isAbsolute(name) || /[\\/]/.test(name) ? [resolve(name)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => resolve(directory.replace(/^"|"$/g, ''), name));
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* 只查询显式入口，不输出环境路径。 */ }
  }
  throw new Error('未找到 PowerShell 7 入口，请指定 --powershell');
}
const parameters = process.argv.slice(2);
if (parameters.includes('--help')) {
  process.stdout.write('用法：node backend/tests/tool-supply-commit-failure-smoke.ts [--probe-only] [--release] [--bin-dir 预构建目录] [--powershell pwsh.exe路径] [--rounds 1..5]\n');
  process.stdout.write('前置：Windows/NTFS、PowerShell 7；完整验收由主代理预构建 apk-server 和 deviceforge-tool-supply-plugin。夹具无需 Rust 构建。\n');
} else {
  assert.equal(process.platform, 'win32', '本夹具只验证 Windows 局部 NTFS ACL');
  const profile = parameters.includes('--release') ? 'release' : 'debug'; const probeOnly = parameters.includes('--probe-only');
  let binDirectory = join(backend, 'target', profile); let shell = 'pwsh.exe'; let rounds = 1;
  for (let index = 0; index < parameters.length; index++) {
    const flag = parameters[index]; if (flag === '--release' || flag === '--probe-only') continue;
    const next = parameters[++index]; assert.ok(next, '选项缺少值');
    if (flag === '--bin-dir') binDirectory = resolve(next);
    else if (flag === '--powershell') shell = next;
    else if (flag === '--rounds') { rounds = Number(next); assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5); }
    else throw new Error('未知驱动选项');
  }
  for (let round = 1; round <= rounds; round++) {
    const root = resolve(backend, '../artifacts', `tool-supply-commit-failure-${probeOnly ? 'ntfs-probe' : profile}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await mkdir(root, { recursive: true }); const audit = await reporter(root, profile);
    audit.report.scope = ['tool-supply']; audit.report.round = round; audit.report.probe_only = probeOnly;
    audit.report.evidence = probeOnly ? '独立 NTFS 路径探针；未启动宿主或插件，不是插件动态通过'
      : '真实 Rust 宿主/tool-supply 插件、本轮局部 NTFS ACL、独立目录监听及本地合成文本 ZIP';
    audit.report.shutdowns = []; audit.report.plugin_cleaned_after_fault = false;
    audit.report.remaining_gaps = ['仅 Windows/NTFS 合成文本包；不表示真实发布工具或其他文件系统通过',
      '事务清理会覆盖公开提交错误；提交分支依据独立 OS 探针、新状态/旧备份/恢复事件顺序和原字节联合核验，不冒充插件原始 Win32 日志'];
    const scripts = ['tests/tool-supply-commit-failure-smoke.ts', 'tests/fixtures/tool-supply-commit-source.ts',
      'tests/fixtures/tool-supply-commit-cases.ts', 'tests/fixtures/tool-supply-commit-acl.ps1'].map((path) => join(backend, path));
    const dependencies = Object.keys(dependencyDigests).map((path) => join(backend, path));
    const files = [...scripts, ...dependencies]; const directories: string[] = [];
    if (!probeOnly) {
      files.push(join(backend, 'Cargo.toml'), join(backend, 'Cargo.lock'), join(binDirectory, `apk-server${suffix}`),
        join(binDirectory, `deviceforge-tool-supply-plugin${suffix}`)); directories.push(join(backend, 'plugins/tool-supply'));
    }
    const servers: Host[] = []; const stopped = new Set<Host>(); let source: CommitSource | undefined;
    let success = false; const deployed: string[] = [];
    try {
      await audit.check('身份：新增四文件、冻结共享依赖与本轮预构建输入', async () => {
        shell = await resolveShell(shell); files.push(shell);
        audit.report.inputs_before = await identities(backend, directories, files);
        audit.report.dependencies = await identities(backend, [], dependencies);
        for (const dependency of audit.report.dependencies as { path: string; sha256: string }[]) {
          assert.equal(dependency.sha256, dependencyDigests[dependency.path], '共享依赖不是本批冻结版本');
        }
      });
      await audit.check('先决探针：旧备份成功0→新提交拒绝5→恢复成功0，撤销 ACL 后可回收', async () => {
        audit.report.ntfs_probe = await ntfsProbe(root, shell);
      });
      if (!probeOnly) {
        const privateBin = join(root, 'bin'); await mkdir(privateBin);
        for (const name of ['apk-server', 'deviceforge-tool-supply-plugin']) {
          const target = join(privateBin, name + suffix); await copyFile(join(binDirectory, name + suffix), target); deployed.push(target);
        }
        source = await commitSource(); const remote = source;
        await mkdir(join(root, 'browser-plugins')); await mkdir(join(root, 'supply'));
        const deployment = await deploy(root, 'tool-supply', { manifest_url: `${source.base}/catalog`, install_root: join(root, 'supply'),
          allow_http: true, download_limit_bytes: 1048576, extracted_limit_bytes: 1048576, file_limit: 16 }, privateBin);
        const plugin = join(deployment.directory, `deviceforge-tool-supply-plugin${suffix}`);
        deployed.push(plugin, join(deployment.directory, 'manifest.json'), join(deployment.directory, 'tool-supply.config.json'));
        audit.report.deployed_before = await identities(root, [], deployed);
        const running = await host(root, privateBin); servers.push(running);
        await audit.check('宿主：仅 tool-supply 部署，HTTP v2/MCP 目录及日志关联', async () => {
          await running.ready(); const listed = await running.request('/api/v2/plugins'); assert.equal(listed.response.status, 200);
          assert.ok(Array.isArray(listed.json)); assert.deepEqual(listed.json.map((item: unknown) => object(item).id), ['tool-supply']);
          assert.deepEqual(await running.mcp('deviceforge.list_plugins', {}), listed.json);
          const manifest = deployment.manifest as { operations: { name: string; execution: { total_timeout_ms: number } }[] };
          const install = manifest.operations.find((operation) => operation.name === 'install'); assert.ok(install);
          assert.ok(install.execution.total_timeout_ms >= 120000); audit.report.install_timeout_ms = install.execution.total_timeout_ms;
        });
        await commitCases(running, remote, audit, root, privateBin, plugin, shell,
          (server) => { servers.push(server); }, (server) => { stopped.add(server); });
        await audit.check('来源：三次合成包下载，没有自动重试或外部请求', async () => {
          assert.deepEqual(remote.faults, []); assert.equal(remote.calls.filter((call) => call.kind === 'archive').length, 3);
          assert.ok(remote.calls.every((call) => call.closed));
        });
      }
      success = true;
    } catch (error) { audit.report.failure = audit.failure(error); }
    finally {
      for (const [index, server] of servers.entries()) {
        if (!stopped.has(server)) {
          try { await normalShutdown(server, audit, `宿主 ${index + 1}：正常 exit0、没有强杀、端口释放`); }
          catch (error) { success = false; audit.report.shutdown_failure = audit.failure(error); }
        }
      }
      audit.report.requests = servers.flatMap((server, index) => server.requests.map((request) => ({ host_epoch: index + 1, ...request })));
      if (source) {
        try {
          await audit.check('合成源：连接关闭与监听端口释放', async () => {
            const shutdown = await source!.close(); audit.report.source_shutdown = shutdown;
            assert.equal(shutdown.port_released, true); assert.equal(shutdown.faults, 0);
          });
        } catch (error) { success = false; audit.report.source_shutdown_failure = audit.failure(error); }
        audit.report.source_calls = source.calls; audit.report.source_events = source.events;
        audit.report.source_faults = source.faults;
      }
      try {
        await audit.check('身份：输入和隔离二进制/配置副本前后不变', async () => {
          audit.report.inputs_after = await identities(backend, directories, files);
          assert.deepEqual(audit.report.inputs_after, audit.report.inputs_before);
          if (deployed.length) {
            audit.report.deployed_after = await identities(root, [], deployed);
            assert.deepEqual(audit.report.deployed_after, audit.report.deployed_before);
          }
          audit.report.inputs_stable = true;
        });
      } catch (error) { success = false; audit.report.input_failure = audit.failure(error); }
      audit.report.passed = success; audit.report.finished_at = new Date().toISOString();
      if (!probeOnly) audit.report.synthetic_package_count = packages.length;
      try { await audit.flush(); }
      catch (error) {
        success = false; audit.report.passed = false;
        try {
          await writeFile(join(root, 'final-publication-failure.json'), JSON.stringify({ passed: false, exit_code: 1,
            failure: audit.failure(error), at: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
        } catch { /* 保留已发布报告与临时报告，不再覆盖证据。 */ }
      }
      process.stdout.write(`${success ? '通过' : '失败'}：${probeOnly ? '独立 NTFS 探针' : '真实宿主专项'}第 ${round} 轮；报告 ${join(root, 'report.json')}\n`);
      if (!success) { process.exitCode = 1; break; }
    }
  }
}
