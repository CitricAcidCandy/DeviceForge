import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { attachWorkspacePackageUpdates, workspacePackageUpdates } from '../scripts/workspace-package-updates.ts';
import type { WorkspacePackageDirectory } from '../scripts/workspace-plugin-packages.ts';
import { workspaceModuleResolution } from '../scripts/workspace-module-resolution.ts';

type PackageEvent = 'add' | 'change' | 'unlink';
type Listener = (file: string) => void;
const root = resolve('G:/Rust/DeviceForge/frontend');
const manifest = (project = 'business-kit') => join(root, 'plugins', project, 'package.json');
const source = (project: string, file: string) => join(root, 'plugins', project, 'src', file);
const baseline: WorkspacePackageDirectory = { aliases: [
  { find: '@example/business', replacement: source('business-kit', 'index.ts') },
], diagnostics: [] };

function fixture() {
  const aliases = new Map(baseline.aliases.map(({ find, replacement }) => [find, replacement]));
  const listeners = new Map<PackageEvent, Set<Listener>>();
  const registrations: { readonly event: PackageEvent; readonly listener: Listener }[] = [];
  const removals: { readonly event: PackageEvent; readonly listener: Listener }[] = [];
  const reads: string[] = [], reports: WorkspacePackageDirectory['diagnostics'][] = [];
  const changes: { readonly action: 'invalidate' | 'reload'; readonly entries: readonly (readonly [string, string])[] }[] = [];
  let directory = baseline, failure: Error | null = null;
  const dispose = attachWorkspacePackageUpdates(root, aliases, {
    watcher: {
      on(event, listener) {
        let group = listeners.get(event);
        if (!group) { group = new Set(); listeners.set(event, group); }
        group.add(listener); registrations.push({ event, listener });
      },
      off(event, listener) { listeners.get(event)?.delete(listener); removals.push({ event, listener }); },
    },
    invalidate() { changes.push({ action: 'invalidate', entries: [...aliases] }); },
    reload() { changes.push({ action: 'reload', entries: [...aliases] }); },
    report(diagnostics) { reports.push(diagnostics); },
  }, (requestedRoot) => {
    reads.push(requestedRoot);
    if (failure) throw failure;
    return directory;
  });
  return {
    aliases, reads, reports, changes, registrations, removals, dispose,
    directory(value: WorkspacePackageDirectory) { directory = value; failure = null; },
    fail(error: Error) { failure = error; },
    emit(event: PackageEvent, file: string) { for (const listener of [...listeners.get(event) ?? []]) listener(file); },
    active: () => [...listeners.values()].reduce((count, group) => count + group.size, 0),
  };
}

test('开发包add、change、unlink逐事件只读一次目录并原位更新同张公开出口表', () => {
  const f = fixture(), retained = f.aliases;
  const menu = { find: '@example/business/dropdown-menu', replacement: source('business-kit', 'dropdown-menu.tsx') };
  try {
    assert.deepEqual(f.reads, [], '接线已有目录表时不重复扫描');
    f.directory({ aliases: [...baseline.aliases, menu], diagnostics: [] });
    f.emit('add', manifest());
    assert.equal(f.aliases, retained);
    assert.equal(f.aliases.get(menu.find), menu.replacement, '新增出口应立即可供原解析函数读取');
    assert.deepEqual(f.reads, [root]);
    assert.deepEqual(f.changes.map(({ action }) => action), ['invalidate', 'reload']);
    assert.ok(f.changes.every(({ entries }) => entries.some(([find, replacement]) =>
      find === menu.find && replacement === menu.replacement)), '先更新目录，再撤销模块缓存与刷新');

    const updated = { ...menu, replacement: source('business-kit', 'menu-next.tsx') };
    f.directory({ aliases: [...baseline.aliases, updated], diagnostics: [] });
    f.emit('change', manifest().replaceAll('\\', '/'));
    assert.equal(f.aliases.get(menu.find), updated.replacement);
    assert.equal(f.reads.length, 2);
    assert.equal(f.changes.length, 4);

    f.directory(baseline);
    f.emit('unlink', manifest());
    assert.equal(f.aliases.has(menu.find), false, '删除包或出口时撤销旧映射');
    assert.deepEqual([...f.aliases], baseline.aliases.map(({ find, replacement }) => [find, replacement]));
    assert.deepEqual(f.reads, [root, root, root]);
    assert.equal(f.changes.length, 6);
  } finally { f.dispose(); }
});

test('普通源码、根包及深层node_modules事件不扫描开发包目录或刷新页面', () => {
  const f = fixture();
  try {
    for (const event of ['add', 'change', 'unlink'] satisfies readonly PackageEvent[]) {
      for (const file of [source('business-kit', 'index.ts'), join(root, 'package.json'),
        join(root, 'plugins', 'business-kit', 'node_modules', 'nested', 'package.json'),
        join(root, 'plugins', 'business-kit', 'src', 'package.json'),
        join(root, 'node_modules', 'nested', 'package.json'),
        join(root, '..', 'outside', 'plugins', 'other', 'package.json')]) f.emit(event, file);
    }
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.changes, []);
    assert.deepEqual(f.reports, []);
    assert.deepEqual([...f.aliases], baseline.aliases.map(({ find, replacement }) => [find, replacement]));
  } finally { f.dispose(); }
});

test('公开出口内容不变时不撤模块缓存或重载，枚举顺序变化也不刷新', () => {
  const f = fixture();
  const extra = { find: '@example/business/model', replacement: source('business-kit', 'model.ts') };
  try {
    f.directory(baseline); f.emit('change', manifest());
    assert.deepEqual(f.reads, [root]);
    assert.deepEqual(f.changes, []);
    f.directory({ aliases: [extra, ...baseline.aliases], diagnostics: [] });
    f.emit('change', manifest());
    assert.equal(f.changes.length, 2);
    f.directory({ aliases: [...baseline.aliases, extra], diagnostics: [] });
    f.emit('change', manifest());
    assert.equal(f.reads.length, 3);
    assert.equal(f.changes.length, 2, '目录输出顺序不构成出口语义变化');
  } finally { f.dispose(); }
});

test('重复身份和无效工程沿原目录报告诊断，其他插件新出口仍立即生效', () => {
  const f = fixture();
  const valid = { find: '@example/independent/new', replacement: source('independent', 'new.ts') };
  const diagnostics = [
    { project: '@example/duplicate', message: '多个工程声明相同公开出口，全部排除' },
    { project: 'invalid-project', message: '公开开发出口不存在' },
  ];
  try {
    f.directory({ aliases: [...baseline.aliases, valid], diagnostics });
    f.emit('change', manifest('invalid-project'));
    assert.deepEqual(f.reports, [diagnostics], '不隐藏原解析器的项目与具体诊断');
    assert.equal(f.aliases.get(valid.find), valid.replacement);
    assert.equal(f.aliases.has('@example/duplicate'), false);
    assert.equal(f.changes.length, 2, '局部目录错误不能冻结独立新出口');
    f.directory({ aliases: [...baseline.aliases, valid], diagnostics: [] });
    f.emit('change', manifest('invalid-project'));
    assert.deepEqual(f.reports.at(-1), [], '后续读取成功应允许清除当前诊断');
    assert.equal(f.changes.length, 2, '只有诊断变化时不刷新业务页面');
  } finally { f.dispose(); }
});

test('目录读取抛错保留旧出口并报告有界诊断，不回显任意异常正文且下一事件仍可更新', () => {
  const f = fixture();
  const sensitiveMessage = '随机原始异常正文以及不应公开的本机环境细节';
  try {
    f.fail(new Error(sensitiveMessage));
    assert.doesNotThrow(() => f.emit('change', manifest()));
    assert.deepEqual([...f.aliases], baseline.aliases.map(({ find, replacement }) => [find, replacement]));
    assert.deepEqual(f.changes, []);
    assert.equal(f.reads.length, 1);
    const diagnostic = f.reports.at(-1); assert.ok(diagnostic?.length);
    assert.equal(JSON.stringify(diagnostic).includes(sensitiveMessage), false);
    const valid = { find: '@example/recovered', replacement: source('recovered', 'index.ts') };
    f.directory({ aliases: [...baseline.aliases, valid], diagnostics: [] });
    f.emit('change', manifest('recovered'));
    assert.equal(f.aliases.get(valid.find), valid.replacement);
    assert.equal(f.reads.length, 2);
    assert.equal(f.changes.length, 2, '旧读取失败不阻止独立的新目录变化');
  } finally { f.dispose(); }
});

test('停止观察精确撤销三类监听，已保存的晚到回调也不能读取或改动目录', () => {
  const f = fixture();
  assert.equal(f.active(), 3);
  assert.deepEqual(f.registrations.map(({ event }) => event), ['add', 'change', 'unlink']);
  f.dispose();
  assert.equal(f.active(), 0);
  assert.deepEqual(f.removals, f.registrations, '每类事件使用原回调撤销');
  f.directory({ aliases: [], diagnostics: [{ project: 'late', message: '晚到目录不应再被读取' }] });
  for (const { listener } of f.registrations) listener(manifest());
  for (const event of ['add', 'change', 'unlink'] satisfies readonly PackageEvent[]) f.emit(event, manifest());
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.reports, []);
  assert.deepEqual(f.changes, []);
  assert.deepEqual([...f.aliases], baseline.aliases.map(({ find, replacement }) => [find, replacement]));
  f.dispose();
  assert.equal(f.removals.length, 3, '重复停止不能重复解绑或影响其他观察者');
});

test('隔离真实Vite对同一URL的失败导入随公开出口add、change、unlink重新解析', async () => {
  const { createServer } = await import('vite');
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'workspace-package-updates-vite-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }), 'utf8');
    await writeFile(join(directory, 'consumer.js'), 'export { value } from "@example/late/feature";\n', 'utf8');
    const aliases = new Map<string, string>();
    server = await createServer({
      root: directory, configFile: false, logLevel: 'silent', cacheDir: join(directory, '.vite'),
      plugins: [...workspaceModuleResolution(aliases).plugins, workspacePackageUpdates(directory, aliases)],
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    const client = server;
    const sameUrl = '/consumer.js';
    await assert.rejects(() => client.transformRequest(sameUrl), /@example\/late\/feature/,
      '首次缺失公开出口必须报告真实导入失败');

    const project = join(directory, 'plugins', 'late');
    const projectManifest = join(project, 'package.json');
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'src', 'feature.js'), 'export const value = "first";\n', 'utf8');
    await writeFile(projectManifest, JSON.stringify({ name: '@example/late',
      exports: { './feature': { development: './src/feature.js' } } }), 'utf8');
    client.watcher.emit('add', projectManifest);
    assert.equal(aliases.get('@example/late/feature'), join(project, 'src', 'feature.js'));
    const added = await client.transformRequest(sameUrl); assert.ok(added);
    assert.match(added.code, /\/plugins\/late\/src\/feature\.js/,
      '同一失败URL在新增出口后必须能重新解析，无需重建Vite或初始Map');

    await writeFile(join(project, 'src', 'changed.js'), 'export const value = "changed";\n', 'utf8');
    await writeFile(projectManifest, JSON.stringify({ name: '@example/late',
      exports: { './feature': { development: './src/changed.js' } } }), 'utf8');
    client.watcher.emit('change', projectManifest);
    const changed = await client.transformRequest(sameUrl); assert.ok(changed);
    assert.match(changed.code, /\/plugins\/late\/src\/changed\.js/,
      '已成功解析过的URL也必须改用当前公开出口');
    assert.doesNotMatch(changed.code, /\/plugins\/late\/src\/feature\.js/);

    await unlink(projectManifest);
    client.watcher.emit('unlink', projectManifest);
    assert.equal(aliases.has('@example/late/feature'), false);
    await assert.rejects(() => client.transformRequest(sameUrl), /@example\/late\/feature/,
      '删除出口后不得复用旧成功转换或已解析模块缓存');
  } finally {
    try { await server?.close(); }
    finally {
      const checked = await realpath(directory), expectedParent = await realpath(artifacts);
      assert.equal(dirname(checked), expectedParent, '仅回收本次G盘artifacts直接子夹具');
      assert.ok(checked.startsWith(join(expectedParent, 'workspace-package-updates-vite-')));
      await rm(checked, { recursive: true, force: true });
    }
  }
});
