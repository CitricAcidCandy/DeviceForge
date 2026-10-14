import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity, verifyPersistedLogs } from './unified-discovery-smoke/evidence.mjs';
import { consume, verifyJobs } from './performance-consumption-smoke/cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv.includes('--release') ? 'release' : 'debug';
assert.ok(
  process.argv.slice(2).every((value) => value === '--release'),
  '仅支持 --release 参数',
);
const directory = join(
  root,
  'artifacts',
  `performance-consumption-service-${profile}-${Date.now()}`,
);
const snapshotRoot = join(directory, 'snapshot'),
  dataRoot = join(directory, 'data');
await mkdir(snapshotRoot, { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  profile,
  platform: process.platform,
  architecture: process.arch,
  passed: false,
  checks: [],
  requests: [],
  jobs: [],
  inputs: [],
  real_device_verified: false,
  real_fps_verified: false,
  scope: '本机真实 Rust HTTP/MCP、实际 TypeScript 性能工厂、合成 performance_demo 插件',
  limitations: [
    '合成插件数值不证明真机 CPU/FPS',
    '不包含浏览器视觉、第三方 MCP 客户端、正式 npx 或跨平台',
  ],
};
let host;
let failure;
async function copyInput(source, destination) {
  const before = await fileIdentity(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const after = await fileIdentity(destination);
  assert.deepEqual(after, { ...before, path: destination });
  report.inputs.push({
    source: relative(root, source),
    copy: relative(directory, destination),
    bytes: before.bytes,
    sha256: before.sha256,
  });
}
async function copyTree(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name),
      to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile() && entry.name.endsWith('.ts')) await copyInput(from, to);
  }
}
try {
  report.stage = '冻结运行输入';
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binary = join(snapshotRoot, `apk-server${suffix}`),
    plugin = join(snapshotRoot, `deviceforge-performance-demo-plugin${suffix}`);
  await copyInput(join(root, 'backend/target', profile, `apk-server${suffix}`), binary);
  await copyInput(
    join(root, 'backend/target', profile, `deviceforge-performance-demo-plugin${suffix}`),
    plugin,
  );
  await copyInput(
    join(root, 'backend/plugins/performance-demo/manifest.example.json'),
    join(snapshotRoot, 'manifest.example.json'),
  );
  await copyTree(join(root, 'frontend/src'), join(snapshotRoot, 'frontend/src'));
  await writeFile(
    join(directory, 'source-manifest.json'),
    JSON.stringify(report.inputs, null, 2) + '\n',
    { flag: 'wx' },
  );
  report.checks.push({ name: '宿主、合成插件和 TypeScript 源码副本身份稳定', passed: true });
  report.stage = '启动空宿主';
  host = await prepareHost({
    root,
    binary,
    directory: dataRoot,
    report,
    port: await reservePort(),
    performancePlugin: 'performance_demo',
  });
  await host.ready();
  await mkdir(join(host.plugins, 'performance_demo'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(snapshotRoot, 'manifest.example.json'), 'utf8'));
  manifest.executable = plugin;
  await writeFile(
    join(host.plugins, 'performance_demo', 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' },
  );
  const loaded = await host.client.post('/api/v2/plugins/performance_demo/load');
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.cleanup_failed, false);
  report.generations = { first: loaded.generation };
  assert.ok((await host.client.tools()).includes('plugin.performance_demo.sample'));
  await consume({ root, directory, snapshotRoot, host, report });
  await verifyJobs({ host, report });
  report.stage = '关闭与持久日志';
  await host.shutdown();
  await host.verifyIdentity();
  await verifyPersistedLogs(dataRoot, [host.client], report);
  report.checks.push({ name: '宿主正常退出、端口释放、Job/事件与日志关联落盘', passed: true });
  report.stage = '最终输入身份';
  for (const entry of report.inputs) {
    const [source, copy] = await Promise.all([
      fileIdentity(join(root, entry.source)),
      fileIdentity(join(directory, entry.copy)),
    ]);
    assert.equal(source.sha256, entry.sha256, entry.source);
    assert.equal(source.bytes, entry.bytes, entry.source);
    assert.equal(copy.sha256, entry.sha256, entry.copy);
    assert.equal(copy.bytes, entry.bytes, entry.copy);
  }
  report.inputs_stable = true;
  report.checks.push({ name: '运行前后当前输入与独立副本摘要稳定', passed: true });
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure_stage = report.stage;
  report.error = { name: error.name, message: String(error.message).slice(0, 1500) };
} finally {
  if (host) {
    try {
      await host.finish();
    } catch (error) {
      failure ??= error;
      report.cleanup_error = { name: error.name, message: String(error.message).slice(0, 1000) };
      report.passed = false;
    }
  }
  report.completed_at = new Date().toISOString();
  report.retained_directory = directory;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      jobs: report.jobs.length,
      report: join(directory, 'report.json'),
      failure_stage: report.failure_stage,
      error: report.error,
    }) + '\n',
  );
  if (failure) process.exitCode = 1;
}
