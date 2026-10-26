// 第三方包只依赖公开描述；Node 是本次真实可执行工具，不编译或注入执行器。
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { writeZip } from '../plugin-releases/archive-write.mjs';
import { digest, identity, json, save } from './evidence.mjs';

const manifest = (dependencies) => ({ format_version: 1, dependencies });
const probe = { entry: 'main', args: ['--version'], pattern: '^v([0-9]+\\.[0-9]+\\.[0-9]+)', timeout_ms: 3000 };
export const scriptArgs = ['带空格的参数', 'literal&value;not-a-shell'];
export const configuration = {
  version: 1, schema: { type: 'object', additionalProperties: false,
    properties: { helper: { type: 'string' }, setting: { type: 'string' } }, required: ['helper', 'setting'] },
  defaults: { helper: '', setting: '本轮旧配置必须保留' }, apply_policy: 'next_invocation',
};

export function dependency(id, extra = {}) {
  return { id, name: '第三方模拟程序', version_requirement: `=${process.versions.node}`, required: true,
    entries: ['main'], requires: [], discovery: [], probe: structuredClone(probe), sources: [], bindings: [], ...extra };
}

export function component(kind, id, dependencies, { bind = true, declared = true, runtimeDependency } = {}) {
  assert.ok(['server', 'browser'].includes(kind));
  assert.ok(!runtimeDependency || kind === 'server', '浏览器不直接执行服务器运行时');
  const entryPath = runtimeDependency ? 'index.mjs' : kind === 'server' ? 'dist/index.mjs' : 'dist/index.js';
  const version = '1.0.0';
  const descriptor = { name: `dependency-smoke-${id}-${kind}`, version, type: 'module',
    deviceforge: { kind, manifest: 'plugin.json', entrypoints: { any: {
      runtime: runtimeDependency ? 'script' : kind === 'server' ? 'node' : 'browser', path: entryPath,
      ...(runtimeDependency ? { dependency: runtimeDependency } : {}) } } } };
  const plugin = kind === 'server'
    ? { id, version, protocol_version: 1, args: runtimeDependency ? scriptArgs : [], configuration,
      operations: [{ name: 'inspect', title: '实际读取已绑定工具', input_schema: { type: 'object', additionalProperties: false } }] }
    : { id, version, api_version: 2, configuration };
  const script = `import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const request=JSON.parse(readFileSync(0,'utf8'));
const values=JSON.parse(readFileSync(process.env.DEVICEFORGE_PLUGIN_CONFIG,'utf8'));
if(!values.helper)throw new Error('依赖路径尚未绑定');
const child=spawnSync(values.helper,['--version'],{encoding:'utf8',windowsHide:true,timeout:5000});
if(child.error||child.status!==0)throw new Error('实际工具执行失败');
process.stdout.write(JSON.stringify({protocol_version:1,request_id:request.request_id,
result:{version:child.stdout.trim().replace(/^v/,''),setting:values.setting,helper:values.helper,
runtime_executable:process.execPath,runtime_argv:process.argv,runtime_pid:process.pid,runtime_parent_pid:process.ppid}}));\n`;
  const files = [
    { path: 'package.json', bytes: json(descriptor) }, { path: 'plugin.json', bytes: json(plugin) },
    { path: entryPath, bytes: kind === 'server' ? script
      : `export default {id:${JSON.stringify(id)},version:'1.0.0',apiVersion:2,panels:[]};\n` },
  ];
  const dependenciesValue = manifest(dependencies.map((value, index) => ({ ...structuredClone(value),
    bindings: kind === 'server' && bind && index === 0 ? [{ component_id: '', config_pointer: '/helper', entry: 'main' }] : [] })));
  if (declared) files.push({ path: 'dependencies.json', bytes: json(dependenciesValue) });
  return { target: { kind, id }, dependencies: dependenciesValue, files, archive: npmTgz(files) };
}

export async function prepareFixtures(root, sourceBase, runId) {
  const directory = join(root, 'fixtures');
  await mkdir(directory);
  const environmentDirectory = join(directory, 'environment'), user = join(root, 'user/.deviceforge');
  await mkdir(environmentDirectory);
  await mkdir(join(user, 'preexisting-tool'), { recursive: true });
  const envProgram = join(environmentDirectory, 'node.exe');
  const userProgram = join(user, 'preexisting-tool/node.exe');
  await copyFile(process.execPath, envProgram);
  await copyFile(process.execPath, userProgram);
  const node = await identity(process.execPath);
  const archivePath = join(directory, 'node-tool.zip');
  await writeZip(archivePath, [{ name: 'node.exe', path: process.execPath }]);
  const archiveIdentity = await identity(archivePath);
  const missingEntryPath = join(directory, 'node-missing-entry.zip');
  await writeZip(missingEntryPath, [{ name: '说明.txt', bytes: Buffer.from('这个有效归档故意不含声明入口') }]);
  const missingEntryIdentity = await identity(missingEntryPath);
  const networkPath = join(directory, 'node-network.zip');
  await writeZip(networkPath, [{ name: 'node-network.exe', path: process.execPath }]);
  const networkIdentity = await identity(networkPath);
  const sources = { '/node-good.zip': archiveIdentity, '/node-bad-digest.zip': archiveIdentity,
    '/node-missing-entry.zip': missingEntryIdentity, '/node-network.zip': networkIdentity,
    '/node-optional.zip': archiveIdentity };
  const prefix = `third_${runId.replaceAll('-', '').slice(0, 14)}`;
  const source = { kind: 'market', url: `${sourceBase}/node-good.zip`, platform: `${process.platform}-${process.arch}`,
    version: process.versions.node, sha256: archiveIdentity.sha256, size: archiveIdentity.size,
    format: 'zip', entries: { main: 'node.exe' } };
  const shared = dependency(`${prefix}_tool`, { sources: [source] });
  const fromEnvironment = dependency(`${prefix}_environment`, { discovery: [
    { kind: 'environment', value: 'DF_DEPENDENCY_NODE', entries: { main: '.' } },
  ] });
  const fromUser = dependency(`${prefix}_user`, { discovery: [
    { kind: 'user_directory', value: 'preexisting-tool', entries: { main: 'node.exe' } },
  ] });
  const badDigest = dependency(`${prefix}_bad_digest`, { required: false, sources: [{ ...source,
    url: `${sourceBase}/node-bad-digest.zip`, sha256: digest(Buffer.from('故意不同于工具归档的合法摘要')) }] });
  const missingEntry = dependency(`${prefix}_missing_entry`, { required: false, sources: [{ ...source,
    url: `${sourceBase}/node-missing-entry.zip`, sha256: missingEntryIdentity.sha256, size: missingEntryIdentity.size,
    entries: { main: 'missing-node.exe' } }] });
  const conflict = dependency(shared.id, { version_requirement: '>=999.0.0', discovery: fromEnvironment.discovery });
  const sameId = `${prefix}_same`;
  const optional = dependency(`${prefix}_optional`, { required: false,
    sources: [{ ...source, url: `${sourceBase}/node-optional.zip` }] });
  const components = {
    environment: component('server', `${prefix}_environment`, [fromEnvironment]),
    user: component('server', `${prefix}_user`, [fromUser]),
    sameServer: component('server', sameId, [fromEnvironment]),
    sameBrowser: component('browser', sameId, [fromUser]),
    conflict: component('server', `${prefix}_conflict`, [conflict]),
    empty: component('server', `${prefix}_empty`, [], { declared: false }),
    emptyBrowser: component('browser', `${prefix}_empty_browser`, []),
  };
  for (const [name, item] of Object.entries(components)) {
    item.file = join(directory, `${name}.tgz`);
    await writeFile(item.file, item.archive, { flag: 'wx' });
  }
  const releases = {};
  const definitions = {
    a: { id: sameId, dependencies: [shared, fromEnvironment, fromUser, optional], browser: true, script: true },
    b: { id: `${prefix}_reuse`, dependencies: [shared, fromEnvironment, fromUser, optional], script: true },
    coldA: { id: `${prefix}_cold_a`, dependencies: [shared], script: true },
    coldB: { id: `${prefix}_cold_b`, dependencies: [shared], script: true, runtimeSidecar: false },
    badDigest: { id: `${prefix}_bad_digest`, dependencies: [shared, badDigest] },
    missingEntry: { id: `${prefix}_missing_entry`, dependencies: [shared, missingEntry] },
    noSource: { id: `${prefix}_no_source`, dependencies: [dependency(`${prefix}_unavailable`, { discovery: [
      { kind: 'user_directory', value: 'remediation-tool', entries: { main: 'node.exe' } },
    ] })] },
    network: { id: `${prefix}_network`, dependencies: [dependency(`${prefix}_network_tool`, {
      sources: [{ ...source, url: `${sourceBase}/node-network.zip`, sha256: networkIdentity.sha256,
        size: networkIdentity.size, entries: { main: 'node-network.exe' } }],
    })] },
    empty: { id: `${prefix}_empty_release`, dependencies: [] },
    legacyEmpty: { id: `${prefix}_legacy_empty`, dependencies: [], legacy: true },
  };
  for (const [name, definition] of Object.entries(definitions)) {
    releases[name] = await releaseFixture(directory, definition, name);
  }
  const release = releases.a;
  const plan = {
    run_id: runId, node, source_archive: archiveIdentity, source_archives: sources, source_base: sourceBase,
    targets: Object.fromEntries(Object.entries(components).map(([name, item]) => [name, item.target])),
    releases: Object.fromEntries(Object.entries(releases).map(([name, item]) => [name, item.target])),
    contract: '一次发布安装自动发现、复用及下载缺失必需项；独立 scan 不下载，install 仅补救及可选项',
    pending: ['新冻结二进制真实 HTTP/MCP 验收', 'npx 双缓存安装、换业务根后 .deviceforge 持久化复用',
      '真实市场服务器与可信官方 HTTPS 下载源', '浏览器执行、真机、其他平台与性能'],
  };
  await save(join(root, 'fixture-plan.json'), plan);
  return { components, releases, release, shared, envProgram, userProgram, archiveIdentity, sources, node, plan };
}

// 完整发布直接构造公开 v2 字节，不依赖尚未支持 v2 的旧打包器。
async function releaseFixture(directory, { id, dependencies, browser = false, legacy = false, script = false, runtimeSidecar = true }, name) {
  const runtime = script ? dependencies[0] : undefined;
  const server = component('server', `${id}_component`, runtime && runtimeSidecar ? [runtime] : [], {
    declared: Boolean(runtime), ...(runtime ? { runtimeDependency: { id: runtime.id, entry: 'main' } } : {}),
  });
  const components = [server];
  if (browser) components.push(component('browser', `${id}_browser`, [], { declared: false }));
  const dependenciesValue = manifest(dependencies.map((value, index) => ({ ...structuredClone(value), bindings:
    index === 0 ? [{ component_id: server.target.id, config_pointer: '/helper', entry: 'main' }] : [] })));
  const releaseManifest = { format_version: legacy ? 1 : 2, host_api_version: 2, id, version: '1.0.0',
    name: '第三方依赖验收完整发布', description: '不按宿主内置插件名单分支',
    components: components.map((value) => {
      const hash = digest(value.archive);
      return { id: value.target.id, kind: value.target.kind, version: '1.0.0',
        variants: [{ platform: 'any', path: `blobs/${hash}`, sha256: hash, size: value.archive.length, format: 'tgz' }] };
    }),
    tools: [], requirements: [], ...(legacy ? {} : { dependencies: dependenciesValue }) };
  const releasePath = join(directory, `release-v2-${name}.zip`);
  await writeZip(releasePath, [{ name: 'release.json', bytes: json(releaseManifest) },
    ...components.map((value) => ({ name: `blobs/${digest(value.archive)}`, bytes: value.archive }))]);
  await save(join(directory, `release-v2-${name}.json`), releaseManifest);
  const componentFile = runtime ? join(directory, `script-${name}.tgz`) : undefined;
  if (componentFile) await writeFile(componentFile, server.archive, { flag: 'wx' });
  return { target: { kind: 'release', id }, component: server.target, componentFile,
    runtimeDependency: runtime ? { id: runtime.id, entry: 'main' } : undefined, runtimeSidecar,
    components: components.map((value) => value.target),
    file: releasePath, dependencies: dependenciesValue };
}

export async function registerComponents(api, fixtures) {
  for (const [name, item] of Object.entries(fixtures.components)) {
    const installed = await api.http(`/api/v2/plugin-packages/${item.target.kind}?format=tgz`,
      { method: 'POST', bytes: item.archive, status: 201, contentType: 'application/gzip' });
    assert.equal(installed.id, item.target.id);
    if (['environment', 'user', 'sameServer'].includes(name)) {
      assert.equal((await api.view(item.target)).ready, true, '组件上传即应自动发现并绑定，不先点扫描');
      await api.http(`/api/v2/plugins/${item.target.id}/load`, { method: 'POST' });
    }
  }
}

export async function registerRelease(api, release, expectedStatus = 'succeeded') {
  const artifact = await api.http('/api/v2/plugin-installations/artifacts?filename=release-v2.zip',
    { method: 'POST', bytes: await readFile(release.file), status: 201, contentType: 'application/octet-stream' });
  const submitted = await api.http('/api/v2/plugin-installations',
    { method: 'POST', input: { source: { kind: 'offline', artifact_id: artifact.id } }, status: 202 });
  const installed = await api.finish(submitted, expectedStatus);
  if (expectedStatus === 'succeeded') assert.equal(installed.result.id, release.target.id);
  return installed;
}
