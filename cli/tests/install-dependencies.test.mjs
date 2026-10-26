import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { materializeManifest, readPluginDeployment } from '../src/plugin-package.mjs';
import { installPlugin } from '../src/install.mjs';
import { loadRuntime } from '../src/runtime.mjs';
import { npmCommand } from '../src/processes.mjs';
import { inside } from '../src/paths.mjs';

const reference = { id: 'third-party-runtime', entry: 'program' };
const marker = { format_version: 1, dependency: reference };

function dependencies(required = true) {
  return { format_version: 1, dependencies: [{ id: reference.id, name: '第三方脚本运行时',
    version_requirement: '^1.0', required, entries: ['program'], requires: [], discovery: [],
    sources: [], bindings: [] }] };
}

async function fixture(directory, entry = { runtime: 'script', path: 'scripts/entry.mjs', dependency: reference }) {
  const source = join(directory, 'plugin source');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'deviceforge-initial-script',
    version: '1.0.0', scripts: { postinstall: 'node -e "process.exit(99)"' },
    deviceforge: { kind: 'server', manifest: 'plugin.json', entrypoints: { any: entry } } }));
  await writeFile(join(source, 'scripts/entry.mjs'), 'throw new Error("安装阶段不得执行脚本入口");');
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'initial-script', version: '1.0.0',
    protocol_version: 1, args: ['--fixture'], operations: [{ name: 'echo', title: '回显', input_schema: { type: 'object' } }] }));
  await writeFile(join(source, 'dependencies.json'), JSON.stringify(dependencies()));
  return source;
}

async function clean(directory) {
  assert.ok(inside(tmpdir(), directory) && directory !== tmpdir());
  await rm(directory, { recursive: true, force: true });
}

test('script 和带引用 node 的静态清单使用脚本入口，不固定安装机 Node', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-runtime-'));
  try {
    for (const runtime of ['script', 'node']) {
      const parent = join(directory, runtime);
      await mkdir(parent);
      const source = await fixture(parent, { runtime, path: 'scripts/entry.mjs', dependency: reference });
      const published = join(directory, 'deployed', runtime);
      const manifest = await materializeManifest(source, published);
      assert.equal(manifest.executable, join(published, 'scripts/entry.mjs'));
      assert.notEqual(manifest.executable, process.execPath);
      assert.deepEqual(manifest.args, [join(published, 'scripts/entry.mjs'), '--fixture']);
      assert.deepEqual((await readPluginDeployment(source)).runtimeMetadata, marker);
      assert.ok(!JSON.stringify(manifest).includes(source));
    }
  } finally { await clean(directory); }
});

test('运行时引用要求公开必需依赖和有效入口，不接受缺失、可选或非法标识', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-dependency-invalid-'));
  try {
    const source = await fixture(directory);
    const packagePath = join(source, 'package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    const invalid = [undefined, { id: '../runtime', entry: 'program' }, { id: reference.id, entry: '../program' },
      { id: 'undeclared-runtime', entry: 'program' }, { id: reference.id, entry: 'missing' },
      { id: 'builtin.runtime', entry: 'program' }, { id: 'Runtime', entry: 'program' },
      { id: reference.id, entry: 'builtin.program' }, { id: reference.id, entry: 'Program' },
      { ...reference, path: 'C:/developer/node.exe' }, 'node'];
    for (const dependency of invalid) {
      pkg.deviceforge.entrypoints.any.dependency = dependency;
      await writeFile(packagePath, JSON.stringify(pkg));
      await assert.rejects(materializeManifest(source, source), /运行时|script/);
    }
    pkg.deviceforge.entrypoints.any.dependency = reference;
    await writeFile(packagePath, JSON.stringify(pkg));
    await writeFile(join(source, 'dependencies.json'), JSON.stringify(dependencies(false)));
    await assert.rejects(materializeManifest(source, source), /必需依赖/);
    await rm(join(source, 'dependencies.json'));
    await assert.rejects(materializeManifest(source, source), /必需依赖/);
  } finally { await clean(directory); }
});

test('原生入口拒绝 runtime 引用，旧 node 入口保持兼容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-runtime-legacy-'));
  try {
    const source = await fixture(directory, { runtime: 'native', path: 'scripts/entry.mjs', dependency: reference });
    await assert.rejects(materializeManifest(source, source), /原生入口不得/);
    const path = join(source, 'package.json');
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    pkg.deviceforge.entrypoints.any = { runtime: 'node', path: 'scripts/entry.mjs' };
    await writeFile(path, JSON.stringify(pkg));
    const manifest = await materializeManifest(source, source);
    assert.equal(manifest.executable, process.execPath);
    assert.equal((await readPluginDeployment(source)).runtimeMetadata, null);
  } finally { await clean(directory); }
});

test('运行时 required 省略时按公开契约默认为真，重复依赖或入口拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-dependency-shape-'));
  try {
    const source = await fixture(directory);
    const declaration = dependencies();
    delete declaration.dependencies[0].required;
    await writeFile(join(source, 'dependencies.json'), JSON.stringify(declaration));
    assert.deepEqual((await readPluginDeployment(source)).runtimeMetadata, marker);
    declaration.dependencies[0].entries.push('program');
    await writeFile(join(source, 'dependencies.json'), JSON.stringify(declaration));
    await assert.rejects(readPluginDeployment(source), /公开入口无效/);
    const duplicate = dependencies();
    duplicate.dependencies.push({ ...duplicate.dependencies[0] });
    await writeFile(join(source, 'dependencies.json'), JSON.stringify(duplicate));
    await assert.rejects(readPluginDeployment(source), /依赖标识/);
  } finally { await clean(directory); }
});

test('未声明 dependencies 数组按公开默认值视为空，旧包无需依赖前置配置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-empty-dependencies-'));
  try {
    const source = await fixture(directory, { runtime: 'node', path: 'scripts/entry.mjs' });
    await writeFile(join(source, 'dependencies.json'), JSON.stringify({ format_version: 1 }));
    assert.deepEqual((await readPluginDeployment(source)).dependencies.dependencies, []);
    assert.equal((await materializeManifest(source, source)).executable, process.execPath);
    await rm(join(source, 'dependencies.json'));
    assert.equal((await readPluginDeployment(source)).dependencies, null);
  } finally { await clean(directory); }
});

test('本地 script 初始部署写旁置声明与 marker，只报告宿主待检测，不创建工具仓库', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-script-install-'));
  try {
    const source = await fixture(directory);
    await writeFile(join(source, '.deviceforge-runtime.json'), JSON.stringify({ format_version: 99, dependency: { id: 'stale' } }));
    const notices = [];
    const dataDirectory = join(directory, 'user data');
    const result = await installPlugin({ source, dataDirectory }, {
      runtime: await loadRuntime(), environment: {}, report: (message) => notices.push(message),
    });
    const deployed = join(dataDirectory, 'plugins/initial-script');
    assert.deepEqual(JSON.parse(await readFile(join(deployed, 'dependencies.json'), 'utf8')), dependencies());
    assert.deepEqual(JSON.parse(await readFile(join(deployed, '.deviceforge-runtime.json'), 'utf8')), marker);
    const manifest = JSON.parse(await readFile(join(deployed, 'manifest.json'), 'utf8'));
    assert.equal(manifest.executable, join(deployed, 'scripts/entry.mjs'));
    assert.deepEqual(manifest.args, [join(deployed, 'scripts/entry.mjs'), '--fixture']);
    assert.ok(!JSON.stringify(manifest).includes(source));
    assert.equal(result.dependency_status, 'host_check_required');
    assert.match(result.dependency_message, /本次未检测或下载/);
    assert.deepEqual(notices, [result.dependency_message]);
    assert.deepEqual((await readdir(dataDirectory)).sort(), ['.plugins-install', 'plugins']);
    assert.deepEqual(await readdir(join(dataDirectory, '.plugins-install')), []);
  } finally { await clean(directory); }
});

test('离线 TGZ 平铺安装把 npm 根包依赖声明复制到部署根，运行入口只指向最终部署', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-flattened-runtime-'));
  try {
    const source = await fixture(directory, { runtime: 'node', path: 'scripts/entry.mjs', dependency: reference });
    const npm = npmCommand(process.env);
    const packed = await promisify(execFile)(npm.command,
      [...npm.prefix, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', directory],
      { cwd: source, windowsHide: true, timeout: 30000 });
    const archive = join(directory, JSON.parse(packed.stdout)[0].filename);
    const dataDirectory = join(directory, 'user data');
    const result = await installPlugin({ source: archive, dataDirectory }, {
      runtime: await loadRuntime(), environment: {}, report: () => {},
    });
    const deployed = join(dataDirectory, 'plugins/initial-script');
    const nested = join(deployed, 'node_modules/deviceforge-initial-script');
    assert.deepEqual(JSON.parse(await readFile(join(deployed, 'dependencies.json'), 'utf8')), dependencies());
    assert.deepEqual(await readFile(join(deployed, 'dependencies.json')), await readFile(join(nested, 'dependencies.json')));
    assert.deepEqual(JSON.parse(await readFile(join(deployed, '.deviceforge-runtime.json'), 'utf8')), marker);
    const manifest = JSON.parse(await readFile(join(deployed, 'manifest.json'), 'utf8'));
    assert.equal(manifest.executable, join(nested, 'scripts/entry.mjs'));
    assert.notEqual(manifest.executable, process.execPath);
    assert.deepEqual(manifest.args, [join(nested, 'scripts/entry.mjs'), '--fixture']);
    assert.ok(!JSON.stringify(manifest).includes(source));
    assert.ok(!JSON.stringify(manifest).includes('.plugins-install'));
    assert.equal(result.dependency_status, 'host_check_required');
    assert.deepEqual(await readdir(join(dataDirectory, '.plugins-install')), []);
  } finally { await clean(directory); }
});

test('不带 runtime 引用的安装不会保留包内伪造 marker，通知失败不改写已发布结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-runtime-marker-'));
  try {
    const source = await fixture(directory, { runtime: 'node', path: 'scripts/entry.mjs' });
    await writeFile(join(source, '.deviceforge-runtime.json'), JSON.stringify(marker));
    const dataDirectory = join(directory, 'data');
    const result = await installPlugin({ source, dataDirectory }, {
      runtime: await loadRuntime(), environment: {}, report: () => { throw new Error('通知夹具失败'); },
    });
    assert.equal(result.id, 'initial-script');
    const deployed = join(dataDirectory, 'plugins/initial-script');
    await assert.rejects(readFile(join(deployed, '.deviceforge-runtime.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(deployed, 'manifest.json'), 'utf8')).executable, process.execPath);
  } finally { await clean(directory); }
});

test('无效运行时引用安装失败不发布组件，并清理本次暂存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-cli-runtime-rollback-'));
  try {
    const source = await fixture(directory);
    await writeFile(join(source, 'dependencies.json'), JSON.stringify(dependencies(false)));
    const dataDirectory = join(directory, 'data');
    await assert.rejects(installPlugin({ source, dataDirectory }, {
      runtime: await loadRuntime(), environment: {}, report: () => {},
    }), /必需依赖/);
    assert.deepEqual(await readdir(join(dataDirectory, 'plugins')), []);
    assert.deepEqual(await readdir(join(dataDirectory, '.plugins-install')), []);
  } finally { await clean(directory); }
});
