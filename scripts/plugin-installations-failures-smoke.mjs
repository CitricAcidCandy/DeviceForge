// 实际并发、取消、进程中断及忙碌更新保护；只中断脚本自己创建的隔离宿主。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, poll } from './plugin-installations-smoke/host.mjs';
import { launchMarket } from './plugin-installations-smoke/market.mjs';
import { releaseFixture } from './plugin-installations-smoke/fixtures.mjs';
import { publish, inspect, configuration } from './plugin-installations-smoke/scenarios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [profile = 'debug', binaryArgument] = process.argv.slice(2);
assert.ok(
  ['debug', 'release'].includes(profile) && process.argv.length <= 4,
  '用法：node plugin-installations-failures-smoke.mjs [debug|release] [二进制目录]',
);
const binaryDirectory = binaryArgument
  ? resolve(binaryArgument)
  : join(root, 'backend', 'target', profile);
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-installation-failures-'));
const report = {
  timestamp: new Date().toISOString(),
  profile,
  directory: temporary,
  hosts: [],
  requests: [],
  checks: {},
  passed: false,
};
let host, market, gate;
function barrier(path) {
  let enter, release;
  const reached = new Promise((done) => {
    enter = done;
  });
  const pending = new Promise((done) => {
    release = done;
  });
  return { path, enter, release, reached, pending };
}
async function start() {
  return launch({
    binary: join(binaryDirectory, 'apk-server.exe'),
    cwd: root,
    data: join(temporary, 'data'),
    user: join(temporary, 'user'),
    market: market.base,
    report,
  });
}
async function finish(id, expected) {
  const value = await poll(
    () => host.call(`/api/v2/jobs/${id}`),
    (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status),
    '失败路径任务',
    30000,
  );
  assert.equal(value.status, expected, value.error);
  return value;
}
async function toolPath(fixture) {
  const manifest = JSON.parse(await readFile(join(fixture.directory, 'release.json'), 'utf8'));
  return `/api/v1/resources/${manifest.tools[0].variants[0].sha256}`;
}
try {
  market = await launchMarket({
    binary: join(root, 'resource-server', 'target', profile, 'deviceforge-resource-server.exe'),
    cwd: root,
    data: join(temporary, 'market'),
    report,
    beforeRequest: async (method, path) => {
      const current = gate;
      if (method === 'GET' && current?.path === path) {
        current.enter();
        await current.pending;
      }
    },
  });
  const first = await releaseFixture(temporary, { id: 'concurrent_first', hold: true });
  const second = await releaseFixture(temporary, { id: 'concurrent_second' });
  const update = await releaseFixture(temporary, { id: first.id, version: '1.1.0', hold: true });
  const interrupted = await releaseFixture(temporary, {
    id: 'interrupted_feature',
    toolVersion: '9.0.0',
    toolBytes: '中断后应重新获取的独立内容',
  });
  const uncertain = await releaseFixture(temporary, {
    id: 'uncertain_cleanup',
    cleanupFailed: true,
  });
  const uncertainUpdate = await releaseFixture(temporary, {
    id: uncertain.id,
    version: '1.1.0',
    cleanupFailed: true,
  });
  const sources = [];
  // 先发布夹具；实际安装并发在下面用下载屏障验证，避免超过市场四项上传限额。
  for (const fixture of [first, second, update, interrupted, uncertain, uncertainUpdate])
    sources.push(await publish(fixture, market));
  host = await start();
  gate = barrier(await toolPath(first));
  const one = await host.call('/api/v2/plugin-installations', {
    method: 'POST',
    input: { source: sources[0] },
    status: 202,
  });
  await Promise.race([
    gate.reached,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('未进入资源下载')), 10000);
      timer.unref();
    }),
  ]);
  const two = await host.call('/api/v2/plugin-installations', {
    method: 'POST',
    input: { source: sources[1] },
    status: 202,
  });
  await poll(
    () => host.call(`/api/v2/jobs/${two.id}`),
    (value) => value.status === 'running',
    '第二安装开始',
  );
  await host.call(`/api/v2/jobs/${two.id}/cancel`, { method: 'POST' });
  await finish(two.id, 'cancelled');
  gate.release();
  gate = null;
  const installed = (await finish(one.id, 'succeeded')).result;
  await inspect(host, first, installed);
  await host.call(`/api/v2/plugin-installations/${second.id}`, { status: 404 });
  const another = (await host.job('/api/v2/plugin-installations', { source: sources[1] })).result;
  await inspect(host, second, another);
  assert.equal(market.counts.get(`GET ${await toolPath(first)}`), 1);
  report.checks.cancel_waiter_preserves_downloader = true;
  await configuration(host, first, '用户配置不丢失');

  const running = await host.call('/api/v2/jobs', {
    method: 'POST',
    status: 202,
    input: { operation: `plugin.${first.serverId}.hold`, input: {} },
  });
  await poll(
    () => host.call(`/api/v2/jobs/${running.id}`),
    (value) => value.status === 'running',
    '资源调用运行',
  );
  const rejected = await host.job(
    `/api/v2/plugin-installations/${first.id}`,
    { source: sources[2], expected_revision: installed.revision },
    { method: 'PUT', success: false },
  );
  assert.match(rejected.error, /忙|使用|活动|运行|资源/);
  assert.equal(
    (await host.call(`/api/v2/plugin-installations/${first.id}`)).revision,
    installed.revision,
  );
  await finish(running.id, 'succeeded');
  await inspect(host, first, installed, { setting: '用户配置不丢失' });
  report.checks.busy_update_preserves_active_release = true;

  gate = barrier(await toolPath(interrupted));
  await host.call('/api/v2/plugin-installations', {
    method: 'POST',
    input: { source: sources[3] },
    status: 202,
  });
  await Promise.race([
    gate.reached,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('未进入待中断下载')), 10000);
      timer.unref();
    }),
  ]);
  await host.crash();
  host = null;
  gate.release();
  gate = null;
  host = await start();
  const restored = await host.call(`/api/v2/plugin-installations/${first.id}`);
  assert.equal(restored.revision, installed.revision);
  await inspect(host, first, restored, { setting: '用户配置不丢失' });
  await host.call(`/api/v2/plugin-installations/${interrupted.id}`, { status: 404 });
  const recovered = (await host.job('/api/v2/plugin-installations', { source: sources[3] })).result;
  await inspect(host, interrupted, recovered, { value: '中断后应重新获取的独立内容' });
  report.checks.interrupted_download_restarts_without_partial_enable_or_configuration_loss = true;

  const protectedRelease = (await host.job('/api/v2/plugin-installations', { source: sources[4] }))
    .result;
  const cooperativeRead = await host.job('/api/v2/jobs', {
    operation: `plugin.${uncertain.serverId}.inspect`, input: {},
  });
  assert.equal(cooperativeRead.result.result.absolute, true);
  const unconfirmed = await host.job(
    '/api/v2/jobs',
    {
      operation: `plugin.${uncertain.serverId}.unconfirmed`,
      input: {},
    },
    { success: false },
  );
  assert.match(unconfirmed.error, /清理|资源/);
  const plugins = await host.call('/api/v2/plugins');
  assert.equal(plugins.find((plugin) => plugin.id === uncertain.serverId)?.cleanup_failed, true);
  const blockedUpdate = await host.job(
    `/api/v2/plugin-installations/${uncertain.id}`,
    {
      source: sources[5],
      expected_revision: protectedRelease.revision,
    },
    { method: 'PUT', success: false },
  );
  assert.match(blockedUpdate.error, /清理|资源|恢复|受阻/);
  const protectedState = await host.call(`/api/v2/plugin-installations/${uncertain.id}`);
  assert.equal(protectedState.revision, protectedRelease.revision);
  assert.equal(protectedState.status, 'recovery_blocked');
  const enable = await host.job(
    `/api/v2/plugin-installations/${uncertain.id}/enabled`,
    {
      expected_revision: protectedRelease.revision,
      enabled: true,
    },
    { method: 'PATCH', success: false },
  );
  assert.match(enable.error, /清理|恢复|受阻/);
  report.checks.unconfirmed_cleanup_blocks_update_and_reenable = true;
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  gate?.release();
  if (host)
    try {
      await host.stop();
    } catch (error) {
      report.shutdown_error = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  if (market)
    try {
      await market.stop();
    } catch (error) {
      report.market_shutdown_error = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  const bytes = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(temporary, 'report.json'), bytes);
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts', `plugin-installations-failures-${profile}.json`), bytes);
  console.log(
    JSON.stringify(
      { passed: report.passed, directory: temporary, checks: report.checks, error: report.error },
      null,
      2,
    ),
  );
}
