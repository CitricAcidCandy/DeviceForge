import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { inputManifest } from '../harmony-device-smoke/evidence.mjs';
import { sdkVersion, sourceContract } from './contracts.mjs';

const mandatory = ['apk-server.exe', 'plugin/deviceforge-ai-sdk-plugin.exe', 'plugin/manifest.json',
  'plugin/worker/package.json', 'plugin/worker/package-lock.json',
  ...['index', 'probe', 'protocol', 'sdk', 'shutdown'].map(name => 'plugin/worker/dist/' + name + '.js'),
  'sdk-package/package.json', 'sdk-package/dist/index.js', 'node.exe', 'process-probe.exe', 'sdk-cli.exe',
  ...['main.rs', 'windows.rs', 'evidence.rs', 'report.json'].map(name => 'fixture-source/' + name), 'source-manifest.json',
  'frontend/package.json', 'frontend/src/shared/api/index.ts', 'frontend/src/features/ai-sdk/index.ts',
  'frontend/src/features/ai-sdk-streaming/index.ts'];
const expectedSdkHash = '340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4';

export async function tree(root) {
  const records = []; let total = 0, entries = 0;
  const visit = async (directory, depth = 0) => {
    assert.ok(depth <= 24, '冻结输入目录深度必须有界');
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name))) {
      assert.ok(++entries <= 20000 && !item.isSymbolicLink(), '冻结输入不得含符号链接或过量成员');
      const path = join(directory, item.name), info = await lstat(path);
      if (info.isDirectory()) await visit(path, depth + 1);
      else {
        assert.ok(info.isFile() && info.size <= 512 * 1024 * 1024, '冻结成员必须是有界普通文件');
        total += info.size; assert.ok(total <= 2 * 1024 * 1024 * 1024);
        records.push({ ...(await fileIdentity(path)), relative_path: relative(root, path) });
      }
    }
  };
  await visit(root); return records;
}

async function frontendInputs(root) {
  const sourceRoot = join(root, 'frontend', 'src');
  const entries = ['shared/api/index.ts', 'features/ai-sdk/index.ts', 'features/ai-sdk-streaming/index.ts'];
  const paths = new Set();
  const visit = async path => {
    path = resolve(path); if (paths.has(path)) return;
    const local = relative(sourceRoot, path);
    assert.ok(!isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep));
    paths.add(path); assert.ok(paths.size <= 512);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) await visit(resolve(dirname(path), match[1]));
    }
  };
  for (const name of entries) await visit(join(sourceRoot, name));
  return Promise.all([...paths].sort().map(fileIdentity));
}

export async function freezeInputs(context, frozenInput, entry) {
  assert.ok(isAbsolute(frozenInput));
  const before = await tree(frozenInput);
  const actualNames = new Set(before.map(record => record.relative_path.split(sep).join('/')));
  for (const name of mandatory) assert.ok(actualNames.has(name), '冻结输入缺少 ' + name);
  const manifest = JSON.parse(await readFile(join(frozenInput, 'plugin/manifest.json'), 'utf8'));
  sourceContract(manifest);
  const sdk = JSON.parse(await readFile(join(frozenInput, 'sdk-package/package.json'), 'utf8'));
  assert.equal(sdk.name, '@openai/codex-sdk'); assert.equal(sdk.version, sdkVersion);
  assert.equal(before.find(record => record.relative_path.split(sep).join('/') === 'sdk-package/dist/index.js').sha256, expectedSdkHash);
  const compilation = JSON.parse(await readFile(join(frozenInput, 'fixture-source/report.json'), 'utf8'));
  assert.deepEqual(compilation.exit, { code: 0, signal: null });
  assert.equal(compilation.binary.sha256, before.find(record => record.relative_path === 'sdk-cli.exe').sha256);
  for (const name of ['main.rs', 'windows.rs', 'evidence.rs']) {
    const identity = before.find(record => record.relative_path.split(sep).join('/') === 'fixture-source/' + name);
    const source = compilation.actual.find(record => record.path.replaceAll('\\', '/').endsWith('/' + name));
    assert.ok(source); assert.equal(identity.sha256, source.sha256); assert.equal(identity.bytes, source.bytes);
  }
  const copied = [];
  for (const source of before) {
    const target = join(context.snapshotRoot, source.relative_path);
    await mkdir(dirname(target), { recursive: true }); await copyFile(source.path, target);
    const actual = await fileIdentity(target);
    assert.equal(actual.sha256, source.sha256); assert.equal(actual.bytes, source.bytes);
    copied.push({ original: source, actual });
  }
  context.report.frozen_inputs = { root: frozenInput, before, copied, sdk_name: sdk.name, sdk_version: sdk.version };
  context.report.driver_inputs_before = await inputManifest(entry, [process.execPath]);
  context.report.frontend_inputs_before = await frontendInputs(frozenInput);
  context.report.frontend_snapshots = copied.filter(record => record.original.relative_path.startsWith('frontend' + sep));
  context.manifest = manifest;
  context.hostBinary = join(context.snapshotRoot, 'apk-server.exe');
  context.pluginBinary = join(context.snapshotRoot, 'plugin/deviceforge-ai-sdk-plugin.exe');
  context.nodeBinary = join(context.snapshotRoot, 'node.exe');
  context.probeBinary = join(context.snapshotRoot, 'process-probe.exe');
  context.cliBinary = join(context.directory, 'tools/sdk-cli.exe');
  await mkdir(dirname(context.cliBinary), { recursive: true });
  await copyFile(join(context.snapshotRoot, 'sdk-cli.exe'), context.cliBinary);
  context.report.cli_deployment = await fileIdentity(context.cliBinary);
}

export async function prepareInputBase({ root, directory, sdkRoot, fixtureRoot, probeBinary }) {
  await mkdir(directory, { recursive: false });
  const records = [];
  const copy = async (source, target) => {
    const before = await fileIdentity(source);
    await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
    const actual = await fileIdentity(target), after = await fileIdentity(source);
    assert.deepEqual(after, before); assert.equal(actual.sha256, before.sha256); assert.equal(actual.bytes, before.bytes);
    records.push({ original: before, actual, relative_path: relative(directory, target) });
  };
  for (const entry of await tree(sdkRoot)) await copy(entry.path, join(directory, 'sdk-package', entry.relative_path));
  for (const entry of await tree(fixtureRoot)) await copy(entry.path, join(directory, 'fixture-source', entry.relative_path));
  await copy(join(fixtureRoot, 'sdk-cli.exe'), join(directory, 'sdk-cli.exe'));
  await copy(probeBinary, join(directory, 'process-probe.exe'));
  await copy(join(root, 'scripts/harmony-screenshot-smoke/process-probe.rs'), join(directory, 'probe-source/process-probe.rs'));
  await copy(process.execPath, join(directory, 'node.exe'));
  for (const entry of await frontendInputs(root)) await copy(entry.path, join(directory, relative(root, entry.path)));
  await copy(join(root, 'frontend/package.json'), join(directory, 'frontend/package.json'));
  const manifest = { format_version: 1, frozen_at: new Date().toISOString(), prepared_runtime_inputs: true,
    host_and_plugin_pending: true, actual_node_version: process.version, sources: records,
    scope: '冻结官方SDK完整包树、Node、原生模拟CLI及编译原件、OS探针来源与前端传递依赖；不启动服务、不构建或下载' };
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function verifyInputs(context, entry) {
  const frozen = context.report.frozen_inputs;
  frozen.after = await tree(frozen.root); assert.deepEqual(frozen.after, frozen.before);
  context.report.driver_inputs_after = await inputManifest(entry, [process.execPath]);
  assert.deepEqual(context.report.driver_inputs_after, context.report.driver_inputs_before);
  frozen.copied_after = await Promise.all(frozen.copied.map(record => fileIdentity(record.actual.path)));
  assert.deepEqual(frozen.copied_after, frozen.copied.map(record => record.actual));
  context.report.cli_deployment_after = await fileIdentity(context.cliBinary);
  assert.deepEqual(context.report.cli_deployment_after, context.report.cli_deployment);
  context.report.fixture_inputs_after = await Promise.all(context.report.fixture_inputs.map(record => fileIdentity(record.path)));
  assert.deepEqual(context.report.fixture_inputs_after, context.report.fixture_inputs);
  context.report.frontend_inputs_after = await frontendInputs(frozen.root);
  assert.deepEqual(context.report.frontend_inputs_after, context.report.frontend_inputs_before);
  context.report.inputs_stable = true;
  context.report.checks.push({ name: '全部冻结来源、真实部署入口与前端传递副本逐件摘要稳定', passed: true });
}
