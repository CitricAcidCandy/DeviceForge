import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { normalizeManifest } from '../src/plugin-authoring/manifest.mjs';
import { marketMetadata } from '../src/plugin-authoring/market.mjs';
import { packPlugin } from '../src/plugin-authoring/pack.mjs';
import { parseOptions } from '../src/options.mjs';
import { runAuthoring } from '../src/plugin-authoring/commands.mjs';
import { inside } from '../src/paths.mjs';
import { materializeManifest, readMarketMetadata } from '../src/plugin-package.mjs';
import { archiveMembers } from '../../scripts/plugin-releases/archive.mjs';
import { verifyReleaseDirectory } from '../../scripts/plugin-releases/pack.mjs';

const declaration = (components = [{ kind: 'browser', files: ['index.js'],
  entrypoints: { any: { runtime: 'browser', path: 'index.js' } } }]) => ({
  manifest_version: 1, id: 'example', version: '1.2.3', name: '示例功能', description: '用于验证单一清单打包的示例。',
  components,
});
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function fixture(run) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'deviceforge-authoring-'));
  try { await run(root); }
  finally {
    const checked = await realpath(root);
    assert.ok(checked !== base && inside(base, checked));
    await rm(checked, { recursive: true, force: true });
  }
}
async function unpack(file, directory) {
  const members = await archiveMembers(file, 'tgz');
  for (const [path, bytes] of members) {
    const target = join(directory, path.slice('package/'.length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return members;
}

test('单一清单继承身份与版本，生成完整市场默认值并拒绝重复配置', () => {
  const value = normalizeManifest(declaration());
  assert.equal(value.components[0].id, value.id);
  assert.equal(value.components[0].version, value.version);
  const market = marketMetadata(value);
  assert.deepEqual([market.id, market.version, market.name, market.description],
    [value.id, value.version, value.name, value.description]);
  assert.deepEqual(market.categories, ['function']);
  assert.deepEqual(market.applies_to, ['deviceforge']);
  assert.equal(market.supports_mcp, 'none');
  for (const patch of [
    { manifest_version: 2 }, { id: '../x' }, { components: [] }, { version: '^1.0.0' },
    { market: { id: 'duplicate' } }, { market: { name: '重复名称' } },
    { market: { categories: ['device'] } }, { market: { supports_mcp: true } },
    { market: { supports_agent: 'true' } }, { market: { keywords: ['a', 'A'] } },
    { market: { applies_to: [] } }, { unknown: 1 },
  ]) assert.throws(() => normalizeManifest({ ...declaration(), ...patch }));
  const repeated = declaration();
  repeated.components[0].plugin = { id: 'duplicate' };
  assert.throws(() => normalizeManifest(repeated), /重复声明/);
});

test('市场所有公开字段可声明，身份和资源摘要保持自动派生', () => {
  const value = declaration();
  value.market = { summary: '市场简介', keywords: ['任务'], categories: ['integration'], applies_to: ['deviceforge'],
    supports_mcp: 'both', supports_agent: true, restart_policy: 'plugin_reload',
    author: '开发者', license: 'MIT', homepage: 'https://example.com', visibility: 'internal', details: { help: '说明' } };
  const metadata = marketMetadata(normalizeManifest(value));
  for (const [key, expected] of Object.entries(value.market)) assert.deepEqual(metadata[key], expected);
  assert.equal(metadata.resource_id, undefined);
  assert.throws(() => marketMetadata({ ...value, market: { resource_id: 'manual' } }), /未知/);
});

test('浏览器单清单生成身份工厂、组件包、离线闭包和可直接发布的市场资料', async () => fixture(async (root) => {
  const source = join(root, 'manifest.json'), destination = join(root, 'output');
  const value = declaration();
  await writeFile(source, JSON.stringify(value));
  await writeFile(join(root, 'index.js'), 'export default ({id}) => ({panels:[], contributions:{commands:[{id:id+".hello",title:"问候",execute:async()=>({data:"你好",logId:null})}]}});');
  const report = await packPlugin({ source, destination });
  const release = await json(join(destination, 'release.json'));
  const pkgRoot = join(root, 'unpacked');
  const members = await unpack(join(destination, 'components/example.tgz'), pkgRoot);
  assert.ok(members.has('package/plugin.json'));
  const pkg = await json(join(pkgRoot, 'package.json'));
  assert.equal(pkg.deviceforge.entrypoints.any.path, '.deviceforge-entry.js');
  assert.equal(pkg.version, value.version);
  assert.deepEqual(await json(join(pkgRoot, 'plugin.json')), { id: value.id, version: value.version, api_version: 2 });
  const plugin = (await import(pathToFileURL(join(pkgRoot, '.deviceforge-entry.js')).href)).default;
  assert.equal(plugin.id, value.id);
  assert.equal(plugin.version, value.version);
  assert.equal(plugin.contributions.commands[0].id, 'example.hello');
  assert.ok(await readMarketMetadata(pkgRoot, { id: value.id, version: value.version }));
  const { files } = await verifyReleaseDirectory(destination);
  assert.equal(files.size, 1);
  const variant = release.components[0].variants[0];
  const bytes = await readFile(join(destination, variant.path));
  assert.equal(variant.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(variant.size, bytes.length);
  const offline = await archiveMembers(report.archive, 'zip');
  assert.deepEqual([...offline.keys()].sort(), ['market.json', 'release.json', variant.path].sort());
  const plan = await runAuthoring(parseOptions(['plugin', 'plan', destination, '--server', 'http://127.0.0.1:7040']));
  assert.equal(plan.remote_written, false);
  assert.equal(plan.source.release_id, value.id);
  assert.deepEqual(await json(source), value, '打包不改写唯一声明');
  await assert.rejects(packPlugin({ source, destination }), /已存在/);
}));

test('服务器、原生与浏览器成套共用一个版本，组件可显式覆盖', async () => fixture(async (root) => {
  const value = declaration([
    { kind: 'server', root: 'server', files: ['entry.mjs'], plugin: { operations: [{ name: 'echo', title: '回显', input_schema: { type: 'object' } }] },
      entrypoints: { any: { runtime: 'node', path: 'entry.mjs' } } },
    { kind: 'browser', version: '2.0.0', root: 'web', files: ['main.js'], entrypoints: { any: { runtime: 'browser', path: 'main.js' } } },
    { id: 'example.native', kind: 'server', root: 'native', files: ['tool.exe'],
      entrypoints: { 'win32-x64': { runtime: 'native', path: 'tool.exe' } } },
  ]);
  for (const directory of ['server', 'web', 'native']) await mkdir(join(root, directory));
  await writeFile(join(root, 'server/entry.mjs'), 'process.stdin.resume();');
  await writeFile(join(root, 'web/main.js'), 'export default {panels:[]};');
  await writeFile(join(root, 'native/tool.exe'), '原生入口字节夹具，不执行');
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
  const output = join(root, 'output');
  await packPlugin({ source: join(root, 'manifest.json'), destination: output, platform: 'win32-x64' });
  const release = await json(join(output, 'release.json'));
  assert.deepEqual(release.components.map(({id,version}) => [id,version]),
    [['example.server', '1.2.3'], ['example.browser', '2.0.0'], ['example.native', '1.2.3']]);
  const server = join(root, 'deployed');
  await unpack(join(output, 'components/example.server.tgz'), server);
  const manifest = await materializeManifest(server, server);
  assert.equal(manifest.id, 'example.server');
  assert.equal(manifest.protocol_version, 1);
  assert.equal(manifest.operations[0].name, 'echo');
  assert.equal(manifest.executable, process.execPath);
}));

test('共享依赖从唯一声明生成，脚本入口依赖与绑定不会遗漏', async () => fixture(async (root) => {
  const value = declaration([{ kind: 'server', files: ['entry.py'],
    entrypoints: { any: { runtime: 'script', path: 'entry.py', dependency: { id: 'python', entry: 'python' } } } }]);
  value.dependencies = { format_version: 1, dependencies: [{ id: 'python', name: 'Python', version_requirement: '*',
    required: true, entries: ['python'], discovery: [], sources: [], bindings: [] }] };
  await writeFile(join(root, 'entry.py'), 'print("夹具")');
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
  const destination = join(root, 'output');
  await packPlugin({ source: join(root, 'manifest.json'), destination });
  const deployed = join(root, 'deployed');
  await unpack(join(destination, 'components/example.tgz'), deployed);
  assert.equal((await json(join(deployed, 'dependencies.json'))).dependencies[0].id, 'python');
}));

test('入口漏打包、元数据冲突与已取消请求不遗留输出或改写源文件', async () => fixture(async (root) => {
  const source = join(root, 'manifest.json'), destination = join(root, 'output');
  const value = declaration();
  await writeFile(source, JSON.stringify(value));
  await assert.rejects(packPlugin({ source, destination }), /ENOENT/);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  await writeFile(join(root, 'index.js'), 'export default {id:"wrong",panels:[]};');
  await packPlugin({ source, destination });
  const deployed = join(root, 'deployed');
  await unpack(join(destination, 'components/example.tgz'), deployed);
  await assert.rejects(import(pathToFileURL(join(deployed, '.deviceforge-entry.js')).href), /冲突/);
  await assert.rejects(packPlugin({ source, destination: join(root, 'cancelled') }, { signal: AbortSignal.abort() }));
  await assert.rejects(lstat(join(root, 'cancelled')), { code: 'ENOENT' });
  assert.deepEqual(await json(source), value);
}));

test('开发参数只接受清单、输出和发布地址，不启动服务器', () => {
  assert.equal(parseOptions(['plugin', 'pack']).source, 'manifest.json');
  assert.equal(parseOptions(['plugin', 'pack', 'my.json', '--out', 'result']).destination, 'result');
  for (const args of [
    ['plugin', 'pack', '--out'], ['plugin', 'pack', '--api-url', 'http://x'],
    ['plugin', 'pack', '--out', 'a', '--out', 'b'], ['plugin', 'plan', 'result'],
    ['plugin', 'publish', 'result', '--market', 'market.json'],
  ]) assert.throws(() => parseOptions(args));
});

test('发布能力不兼容时零上传，通过后资源和目录严格按序提交', async () => fixture(async (root) => {
  await writeFile(join(root, 'index.js'), 'export default {panels:[]};');
  await writeFile(join(root, 'manifest.json'), JSON.stringify(declaration()));
  const destination = join(root, 'output');
  await packPlugin({ source: join(root, 'manifest.json'), destination });
  const options = { command: 'plugin.publish', directory: destination, server: 'http://resource.test' };
  const denied = [];
  await assert.rejects(runAuthoring(options, { transport: async (url) => {
    denied.push(url.pathname);
    return Response.json({ api_version: 1, release_publication: { format_versions: [1] } });
  } }), /不兼容/);
  assert.deepEqual(denied, ['/api/v1/capabilities']);
  const calls = [];
  const report = await runAuthoring(options, { transport: async (url, init) => {
    calls.push([init.method ?? 'GET', url.pathname]);
    if (url.pathname === '/api/v1/capabilities') return Response.json({ api_version: 1, release_publication: {
      format_versions: [1, 2], host_api_versions: [2], catalog_last: true, immutable_versions: true, resource_max_bytes: 2 ** 31,
    } });
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    if (url.pathname === '/api/v1/catalog') {
      const entry = JSON.parse(init.body);
      assert.equal(entry.id, 'example');
      assert.match(entry.resource_id, /^[a-f0-9]{64}$/);
      assert.equal(entry.details.release_format_version, 2);
      return Response.json(entry);
    }
    const chunks = [];
    if (Buffer.isBuffer(init.body)) chunks.push(init.body);
    else for await (const chunk of init.body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), sha256 = createHash('sha256').update(bytes).digest('hex');
    return Response.json({ id: sha256, sha256, size: bytes.length });
  } });
  assert.equal(report.remote_written, true);
  assert.deepEqual(calls[0], ['GET', '/api/v1/capabilities']);
  assert.deepEqual(calls.at(-1), ['POST', '/api/v1/catalog']);
}));

test('本地依赖按真实字节生成摘要，完整闭包去重且不重复手写资源声明', async () => fixture(async (root) => {
  const value = declaration();
  value.dependencies = { format_version: 1, dependencies: [{ id: 'fixture-tool', name: '工具夹具', version_requirement: '*',
    entries: ['tool'], sources: [], bindings: [] }] };
  value.dependency_files = { 'fixture-tool': { file: 'tool.bin', platform: 'win32-x64', version: '1.0.0', format: 'file', entries: { tool: 'payload' } } };
  await writeFile(join(root, 'tool.bin'), '工具数据，不执行');
  await writeFile(join(root, 'index.js'), 'export default {panels:[]};');
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
  const destination = join(root, 'output');
  await packPlugin({ source: join(root, 'manifest.json'), destination, platform: 'win32-x64' });
  const release = await json(join(destination, 'release.json'));
  const dependency = release.dependencies.dependencies[0].sources[0];
  assert.equal(dependency.sha256, createHash('sha256').update(await readFile(join(root, 'tool.bin'))).digest('hex'));
  assert.equal(dependency.url, `blobs/${dependency.sha256}`);
  assert.equal((await verifyReleaseDirectory(destination)).files.size, 2);
}));

test('CLI 发行清单包含完整开发工具，隔离模块无需宿主源码或私有依赖即可打包', async () => fixture(async (root) => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const pkg = await json(join(repository, 'package.json'));
  const releaseRequire = createRequire(new URL('../../scripts/plugin-releases/package.json', import.meta.url));
  const distribution = join(root, 'distribution');
  await mkdir(join(distribution, 'cli/src'), { recursive: true });
  await cp(join(repository, 'cli/src/plugin-authoring'), join(distribution, 'cli/src/plugin-authoring'), { recursive: true });
  await cp(join(repository, 'cli/src/paths.mjs'), join(distribution, 'cli/src/paths.mjs'));
  const releases = join(distribution, 'scripts/plugin-releases');
  await mkdir(releases, { recursive: true });
  for (const file of await readdir(join(repository, 'scripts/plugin-releases'))) {
    const name = `scripts/plugin-releases/${file}`;
    if (!pkg.files.includes(name) && !(file.startsWith('archive') && file.endsWith('.mjs') &&
      pkg.files.includes('scripts/plugin-releases/archive*.mjs'))) continue;
    await cp(join(repository, name), join(releases, file));
  }
  assert.equal(pkg.dependencies.semver, '7.8.5');
  await mkdir(join(distribution, 'node_modules'), { recursive: true });
  await cp(dirname(releaseRequire.resolve('semver/package.json')), join(distribution, 'node_modules/semver'), { recursive: true });
  const { packPlugin: isolatedPack } = await import(pathToFileURL(join(distribution, 'cli/src/plugin-authoring/pack.mjs')).href);
  await writeFile(join(root, 'index.js'), 'export default {panels:[]};');
  await writeFile(join(root, 'manifest.json'), JSON.stringify(declaration()));
  const report = await isolatedPack({ source: join(root, 'manifest.json'), destination: join(root, 'output') });
  assert.equal(report.id, 'example');
  await assert.rejects(lstat(join(distribution, 'backend')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(distribution, 'frontend')), { code: 'ENOENT' });
}));
