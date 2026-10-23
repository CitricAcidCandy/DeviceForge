// 同一发布npm包，两份全新缓存；插件、配置和工具必须依靠用户根恢复。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packNpx } from './plugin-installations-smoke/npx-package.mjs';
import { launch, port } from './plugin-installations-smoke/host.mjs';
import { launchMarket } from './plugin-installations-smoke/market.mjs';
import { releaseFixture } from './plugin-installations-smoke/fixtures.mjs';
import {
  publish,
  inspect,
  configuration,
  persistedConfiguration,
} from './plugin-installations-smoke/scenarios.mjs';

assert.equal(process.platform, 'win32', '本轮正式验收仅Windows x64');
assert.equal(process.arch, 'x64');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === '--binary-directory'),
  '仅支持 --binary-directory',
);
const binaryDirectory = args[1] ? resolve(args[1]) : join(root, 'backend', 'target', 'release');
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-unified-npx-'));
const report = {
  timestamp: new Date().toISOString(),
  directory: temporary,
  profile: 'release',
  hosts: [],
  requests: [],
  caches: [],
  checks: {},
  passed: false,
  scope:
    '真实npm pack与两独立缓存npx、真实Rust市场和宿主、第三方完整功能安装和用户根持久化；不包含浏览器交互、在线npm发布或设备业务',
};
let host, market;
try {
  const packed = await packNpx({ root, temporary, binaryDirectory });
  report.package = packed;
  const prefix = [packed.npx, '--yes', '--package', packed.archive, 'deviceforge'];
  market = await launchMarket({
    binary: join(root, 'resource-server', 'target', 'release', 'deviceforge-resource-server.exe'),
    cwd: root,
    data: join(temporary, 'market'),
    report,
  });
  const fixture = await releaseFixture(temporary, { id: 'third_party_npx' });
  const source = await publish(fixture, market);
  let revision;
  for (const phase of [1, 2]) {
    const cache = join(temporary, `cache-${phase}`),
      data = join(temporary, `data-${phase}`),
      user = join(temporary, 'user');
    const mcpPort = await port();
    const environment = { npm_config_cache: cache, npm_config_update_notifier: 'false' };
    host = await launch({
      binary: process.execPath,
      cwd: temporary,
      data,
      user,
      market: market.base,
      report,
      environment,
      readyTimeout: 60000,
      argumentsForPort: (webPort) => [
        ...prefix,
        'start',
        '--ip',
        '127.0.0.1',
        '--port',
        String(webPort),
        '--mcp-port',
        String(mcpPort),
        '--data-dir',
        data,
        '--marketplace-url',
        market.base,
      ],
    });
    if (phase === 1) {
      const clean = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
      );
      const cli = await promisify(execFile)(
        process.execPath,
        [
          ...prefix,
          'plugin',
          'install',
          source.source_url,
          '--api-url',
          host.base,
          '--release-id',
          source.release_id,
          '--release-version',
          source.version,
          '--manifest-sha256',
          source.manifest_sha256,
        ],
        {
          cwd: temporary,
          env: { ...clean, ...environment, DEVICEFORGE_USER_DIR: user },
          windowsHide: true,
          timeout: 120000,
        },
      );
      assert.match(cli.stdout, /统一插件安装任务.*已完成/);
      await configuration(host, fixture, '用户配置不丢失');
    }
    const installed = await host.call(`/api/v2/plugin-installations/${fixture.id}`);
    if (revision) assert.equal(installed.revision, revision);
    else revision = installed.revision;
    await inspect(host, fixture, installed, { setting: '用户配置不丢失' });
    await persistedConfiguration(user, fixture);
    const runtimeDirectories = await readdir(join(cache, '_npx'));
    assert.ok(runtimeDirectories.length > 0);
    const entry = { phase, cache, data, user, revision, runtimeDirectories };
    report.caches.push(entry);
    const tool = installed.tools[0];
    assert.equal(
      market.counts.get(`GET /api/v1/resources/${tool.sha256}`),
      1,
      '更换npm缓存不能重新下载工具',
    );
    const html = await (await fetch(host.base, { signal: AbortSignal.timeout(10000) })).text();
    assert.ok(html.includes('<html'), 'npx必须提供实际主网页');
    await host.stop();
    host = null;
  }
  assert.notEqual(report.caches[0].cache, report.caches[1].cache);
  report.checks = {
    actual_npm_package: true,
    cli_online_install: true,
    two_independent_caches: true,
    same_release_and_configuration: true,
    no_repeated_tool_download: true,
    changed_data_root: true,
    served_host: true,
  };
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (host) {
    try {
      await host.stop();
    } catch (error) {
      report.shutdown_error = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  if (market) await market.stop();
  const bytes = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(temporary, 'report.json'), bytes);
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts', 'plugin-installations-npx-smoke-release.json'), bytes);
  console.log(
    JSON.stringify(
      { passed: report.passed, checks: report.checks, directory: temporary, error: report.error },
      null,
      2,
    ),
  );
}
