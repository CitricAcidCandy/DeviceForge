import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';
import { unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { hash, inside, object } from '../scripts/workspace-release-inputs.ts';
import { auditBrowserBundle } from '../scripts/browser-bundle-closure.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { requestUrl, success } from './fixtures.ts';

const parser = registerCompositionStartupImports();
after(parser.dispose);
const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');
const { readPluginModule } = await import('../src/plugins/contracts.ts');
const reportFile = process.env['DEVICEFORGE_OFFICIAL_BUILD_REPORT'];

test('真实官方归档经身份包装装载，停用只撤所属贡献与样式，只读取已有目录', { skip: !reportFile }, async () => {
  assert.ok(reportFile, '本单元需要显式指定实际发行报告，不临时重建或使用历史包替代');
  const report: unknown = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.ok(object(report) && Array.isArray(report.releases) && report.releases.length > 0 &&
    Array.isArray(report.sources) && report.sources.length > 0);
  const releases: readonly unknown[] = report.releases;
  const sources: readonly unknown[] = report.sources;
  const sourceIds = sources.map((item) => {
    assert.ok(object(item) && typeof item.id === 'string');
    return item.id;
  });
  const releaseIds = releases.map((item) => {
    assert.ok(object(item) && typeof item.id === 'string');
    return item.id;
  });
  assert.equal(new Set(sourceIds).size, sourceIds.length, '来源不能包含重复身份');
  assert.equal(new Set(releaseIds).size, releaseIds.length, '发布不能包含重复身份');
  assert.deepEqual([...sourceIds].sort(), [...releaseIds].sort(),
    '真实来源集合必须与最终发布集合一致，不通过固定业务枚举掩盖缺包');
  const artifacts = dirname(resolve(reportFile));
  const temporary = await mkdtemp(join(artifacts, '.artifact-unit-'));
  const browser = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const originals = new Map(['self', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: browser.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: browser.window.document });
  const network: { path: string; method: string }[] = [];
  const readOnlyPaths = [
    '/api/v2/plugin-packages/browser', '/api/v2/plugin-installations',
    '/api/v2/device-providers', '/api/v2/devices',
  ];
  const services = createProductPlatformServices({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      const method = init?.method ?? 'GET';
      network.push({ path, method });
      if (method === 'GET' && readOnlyPaths.includes(path)) return success([]);
      throw new Error('实际归档单元仅允许已有目录读取，禁止自动发现、连接或其他业务操作');
    },
  });
  try {
    const ids: string[] = [];
    for (const item of releases) {
      assert.ok(object(item) && typeof item.id === 'string' && typeof item.version === 'string' &&
        typeof item.archive === 'string' && inside(artifacts, item.archive) && typeof item.sha256 === 'string' &&
        typeof item.bytes === 'number');
      const packReport: unknown = JSON.parse(await readFile(join(dirname(item.archive), 'pack-report.json'), 'utf8'));
      assert.ok(object(packReport) && typeof packReport.archive === 'string' &&
        typeof packReport.sha256 === 'string' && typeof packReport.size === 'number' &&
        typeof packReport.revision === 'string');
      assert.equal(resolve(packReport.archive), resolve(item.archive));
      assert.equal(packReport.id, item.id);
      assert.equal(packReport.version, item.version);
      assert.equal(packReport.sha256, item.sha256);
      assert.equal(packReport.size, item.bytes);
      const zip = await readFile(packReport.archive);
      assert.equal(zip.length, packReport.size, '实际最终 ZIP 大小必须匹配打包报告');
      assert.equal(hash(zip), packReport.sha256, '实际最终 ZIP 摘要必须匹配打包报告');
      assert.ok(zip.length <= 64 * 1024 * 1024);
      const zipNames = new Set<string>();
      let totalSize = 0;
      const files = unzipSync(zip, { filter(entry) {
        assert.ok(!entry.name.includes('\\') && !entry.name.includes('\0') && !entry.name.startsWith('/') &&
          entry.name.split('/').every((part) => part !== '.' && part !== '..' && part !== ''));
        assert.ok(!zipNames.has(entry.name) && zipNames.size < 4096);
        zipNames.add(entry.name);
        totalSize += entry.originalSize;
        assert.ok(Number.isSafeInteger(entry.originalSize) && entry.originalSize >= 0 &&
          totalSize <= 64 * 1024 * 1024, '最终 ZIP 展开超过本单元限额');
        return true;
      } });
      const releaseBytes = files['release.json'];
      assert.ok(releaseBytes, '运行输入必须来自最终 ZIP 内的发布清单');
      assert.equal(hash(releaseBytes), packReport.revision);
      const release: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(releaseBytes));
      assert.ok(object(release) && Array.isArray(release.components));
      assert.equal(release.host_api_version, 2);
      assert.ok(release.format_version === 1 || release.format_version === 2);
      assert.equal(release.id, item.id);
      assert.equal(release.version, item.version);
      assert.equal(release.components.length, packReport.components);
      for (const declaration of release.components) {
        assert.ok(object(declaration) && Array.isArray(declaration.variants));
        for (const variant of declaration.variants) {
          assert.ok(object(variant) && typeof variant.path === 'string' &&
            typeof variant.sha256 === 'string' && typeof variant.size === 'number');
          const blob = files[variant.path];
          assert.ok(blob, '最终 ZIP 缺少发布清单引用的真实组件 blob');
          assert.equal(blob.length, variant.size);
          assert.equal(hash(blob), variant.sha256);
        }
      }
      assert.equal(release.components.length, 1, '官方独立工程每包应只有自己的浏览器组件');
      const component: unknown = release.components[0];
      assert.ok(object(component) && component.kind === 'browser' && component.id === item.id &&
        component.version === item.version && Array.isArray(component.variants));
      const variants: unknown[] = component.variants.filter((variant: unknown) => object(variant) && variant.platform === 'any');
      assert.equal(variants.length, 1);
      const variant = variants[0];
      assert.ok(object(variant) && variant.format === 'tgz' && typeof variant.path === 'string');
      const componentBytes = files[variant.path];
      assert.ok(componentBytes, '实际运行组件只能从最终 ZIP 读取');
      const root = join(temporary, item.id);
      await mkdir(root);
      const members = new Set<string>();
      for await (const entry of extract()([gunzipSync(componentBytes, { maxOutputLength: 64 * 1024 * 1024 })])) {
        assert.ok(entry.header.name.startsWith('package/'));
        assert.ok(!entry.header.name.includes('\\') && !entry.header.name.includes('\0') &&
          entry.header.name.split('/').every((part) => part !== '.' && part !== '..'));
        if (entry.header.type === 'directory') continue;
        assert.ok(!members.has(entry.header.name) && members.size < 4096);
        members.add(entry.header.name);
        const target = resolve(root, entry.header.name.slice('package/'.length));
        assert.ok(inside(root, target) && entry.header.type === 'file');
        const chunks: Uint8Array[] = [];
        for await (const chunk of entry.body) chunks.push(chunk.subarray());
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.concat(chunks), { flag: 'wx' });
      }
      const closure = await auditBrowserBundle(join(root, 'dist'));
      assert.deepEqual(closure.computedImports, []);
      const plugin = readPluginModule(await import(pathToFileURL(join(root, '.deviceforge-entry.js')).href));
      assert.equal(plugin.id, item.id);
      assert.equal(plugin.version, item.version);
      ids.push(plugin.id);
      services.runtime.bundledPlugins.register({ id: plugin.id, plugin, trusted: true });
      await services.runtime.webPlugins.load(plugin.id);
      assert.equal(services.runtime.webPlugins.diagnosticSnapshot().find((entry) => entry.id === plugin.id)?.state, 'loaded');
    }
    const ui = services.runtime.host.ui;
    assert.ok(ui);
    assert.equal(ui.catalog().pages.length, 11);
    assert.equal(new Set(ui.catalog().pages.map((page) => page.route)).size, 11);
    const retained = ui.catalog().pages.filter((page) => page.pluginId !== 'deviceforge_files');
    await services.runtime.webPlugins.unload('deviceforge_files');
    assert.equal(ui.catalog().pages.some((page) => page.route === '/files'), false);
    assert.deepEqual(ui.catalog().pages, retained);
    for (const id of ids.filter((id) => id !== 'deviceforge_files')) await services.runtime.webPlugins.unload(id);
    assert.deepEqual(ui.catalog().pages, []);
    assert.ok(network.every(({ path, method }) => method === 'GET' && readOnlyPaths.includes(path)),
      '激活不能派发设备发现、连接、Job或其他业务操作');
    assert.ok(network.some(({ path }) => path === '/api/v2/device-providers'));
    assert.ok(network.some(({ path }) => path === '/api/v2/devices'),
      '当前真实设备插件首次只读观测应贯通聚合目录，不能由失败夹具静默短路');
    assert.equal(browser.window.document.head.querySelectorAll('style,link[rel="stylesheet"]').length, 0,
      '实际包停用后必须撤销自己的样式资源，不能把构建期CSS注入留在页面');
  } finally {
    await services.dispose();
    browser.window.close();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
    assert.ok(resolve(temporary).startsWith(resolve(artifacts) + sep));
    await rm(temporary, { recursive: true, force: true });
  }
});
