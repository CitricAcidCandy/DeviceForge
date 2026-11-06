import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { inspect } from 'node:util';
import { extract } from 'it-tar';
import { unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import type { Dispose, JsonValue, UiAccess, WebPlugin } from '../src/plugin-sdk/index.ts';
import { hash, inside, object } from '../scripts/workspace-release-inputs.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { requestUrl, success } from './fixtures.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import { legacyRouteSurfaces } from '../src/app/composition/legacy-route-surfaces.ts';
import type { PlatformRuntime } from '../src/app/platform-runtime.ts';

const officialReportFile = process.env['DEVICEFORGE_OFFICIAL_BUILD_REPORT'];
const suiteReportFile = process.env['DEVICEFORGE_WORKSPACE_SUITE_REPORT'];
const requiredReports = officialReportFile && suiteReportFile;
const suiteId = 'workspace_suite.browser', contributorId = 'workspace_contributor';
const fileWorkspace = 'deviceforge_files.workspace', deviceWorkspace = 'deviceforge_devices.workspace';
const originalFileId = 'deviceforge_files.browser.main';
const artifactId = '12345678-1234-4234-8234-123456789abc';

async function json(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(object(value), '发行报告及归档元数据必须是 JSON 对象');
  return value;
}

/** 运行输入只从最终 ZIP 的清单和组件读取，不引用旁路源码或已展开目录。 */
async function browserComponent(directory: string, destination: string) {
  const packed = await json(join(directory, 'pack-report.json'));
  assert.ok(typeof packed.archive === 'string' && typeof packed.sha256 === 'string' &&
    typeof packed.size === 'number' && typeof packed.revision === 'string');
  const archivePath = resolve(directory, packed.archive);
  assert.ok(inside(directory, archivePath));
  const zip = await readFile(archivePath);
  assert.equal(zip.length, packed.size, '最终 ZIP 大小必须与本批打包报告一致');
  assert.equal(hash(zip), packed.sha256, '最终 ZIP 摘要必须与本批打包报告一致');
  assert.ok(zip.length <= 64 * 1024 * 1024);
  const names = new Set<string>();
  let expanded = 0;
  const files = unzipSync(zip, { filter(entry) {
    assert.ok(!entry.name.includes('\\') && !entry.name.includes('\0') &&
      !entry.name.startsWith('/') &&
      entry.name.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
    assert.ok(!names.has(entry.name) && names.size < 4096);
    names.add(entry.name);
    expanded += entry.originalSize;
    assert.ok(Number.isSafeInteger(entry.originalSize) && entry.originalSize >= 0 &&
      expanded <= 64 * 1024 * 1024);
    return true;
  } });
  const releaseBytes = files['release.json'];
  assert.ok(releaseBytes, '发布清单必须来自最终 ZIP 内部');
  assert.equal(hash(releaseBytes), packed.revision);
  const release: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(releaseBytes));
  assert.ok(object(release) && Array.isArray(release.components));
  assert.equal(release.id, packed.id);
  assert.equal(release.version, packed.version);
  assert.equal(release.host_api_version, 2);
  assert.equal(release.components.length, packed.components);
  const components: unknown[] = release.components;
  for (const component of components) {
    assert.ok(object(component) && Array.isArray(component.variants));
    for (const variant of component.variants) {
      assert.ok(object(variant) && typeof variant.path === 'string' &&
        typeof variant.size === 'number' && typeof variant.sha256 === 'string');
      const bytes = files[variant.path];
      assert.ok(bytes, '清单引用的组件必须真实存在于同一 ZIP');
      assert.equal(bytes.length, variant.size);
      assert.equal(hash(bytes), variant.sha256);
    }
  }
  const browsers = components.filter((component) => object(component) && component.kind === 'browser');
  assert.equal(browsers.length, 1);
  const browser = browsers[0];
  assert.ok(object(browser) && typeof browser.id === 'string' &&
    typeof browser.version === 'string' && Array.isArray(browser.variants));
  const variants: unknown[] = browser.variants.filter((variant: unknown) =>
    object(variant) && variant.platform === 'any');
  assert.equal(variants.length, 1);
  const variant = variants[0];
  assert.ok(object(variant) && variant.format === 'tgz' && typeof variant.path === 'string');
  const bytes = files[variant.path];
  assert.ok(bytes);
  await mkdir(destination);
  const members = new Set<string>();
  for await (const entry of extract()([gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })])) {
    const name = entry.header.name;
    assert.ok(name.startsWith('package/') && !name.includes('\\') && !name.includes('\0') &&
      name.split('/').every((part) => part !== '.' && part !== '..'));
    if (entry.header.type === 'directory') continue;
    assert.equal(entry.header.type, 'file');
    assert.ok(!members.has(name) && members.size < 4096);
    members.add(name);
    const target = resolve(destination, name.slice('package/'.length));
    assert.ok(inside(destination, target));
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.concat(chunks), { flag: 'wx' });
  }
  const metadata = await json(join(destination, 'package.json'));
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.version, browser.version);
  assert.ok(object(metadata.deviceforge) && metadata.deviceforge.kind === 'browser' &&
    object(metadata.deviceforge.entrypoints) && object(metadata.deviceforge.entrypoints.any));
  const entrypoint = metadata.deviceforge.entrypoints.any;
  assert.ok(entrypoint.runtime === 'browser' && typeof entrypoint.path === 'string');
  const entry = resolve(destination, entrypoint.path);
  assert.ok(inside(destination, entry) && members.has(`package/${entrypoint.path}`));
  return { id: browser.id, version: browser.version, entry, archivePath, packed };
}

function button(root: ParentNode, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);
  assert.ok(found, `真实归档界面缺少按钮：${name}`);
  return found;
}

function fileInput(root: ParentNode): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('input[placeholder="任务结果中的 UUID"]');
  assert.ok(input, '实际文件视图应呈现产物 ID 草稿输入');
  return input;
}

function contributed(ui: UiAccess, workspaceId: string) {
  return ui.snapshot().instances.filter((instance) => instance.workspaceId === workspaceId &&
    instance.provider?.pluginId === suiteId);
}

async function fixture(withLegacyRoutes = false) {
  assert.ok(officialReportFile && suiteReportFile);
  const officialPath = resolve(officialReportFile), suitePath = resolve(suiteReportFile);
  const officialReport = await json(officialPath), suiteReport = await json(suitePath);
  assert.ok(Array.isArray(officialReport.releases) &&
    typeof suiteReport.suiteDirectory === 'string' && typeof suiteReport.contributorDirectory === 'string');
  const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
  const temporary = await mkdtemp(join(artifacts, '.workspace-suite-dom-'));
  const browser = new JSDOM('<!doctype html><html><head></head><body><div id="test"></div></body></html>', {
    url: 'http://workspace-suite-dom.invalid/#/files', pretendToBeVisual: true,
  });
  const document = browser.window.document;
  const target = document.getElementById('test') ?? assert.fail('JSDOM 缺少实际外壳挂载根');
  const globals: Readonly<Record<string, unknown>> = {
    window: browser.window, self: browser.window, document, navigator: browser.window.navigator,
    Element: browser.window.Element, HTMLElement: browser.window.HTMLElement,
    HTMLInputElement: browser.window.HTMLInputElement, Node: browser.window.Node,
    DocumentFragment: browser.window.DocumentFragment, MutationObserver: browser.window.MutationObserver,
    CustomEvent: browser.window.CustomEvent,
    getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
    requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
    cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
    fetch: async () => { throw new Error('真实归档 DOM 单元禁止直接访问网络'); },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const parser = registerCompositionStartupImports();
  const { act } = await import('react');
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const { createProductPlatformServices } = await import('../src/app/product/platform-services.ts');
  const { createShellHost, SHELL_POINT } = await import('../src/app/composition/shell-host.ts');
  const { readPluginModule } = await import('../src/plugins/contracts.ts');
  let releasePublicUi: Dispose = () => {};
  const slots = withLegacyRoutes ? await createNamedSlotAdapter([]) : null;
  let extensionAccess: PlatformRuntime['extensions'] | null = null;
  const requests: string[] = [], unexpected: string[] = [];
  const directoryPaths = ['/api/v2/plugin-packages/browser', '/api/v2/plugin-installations',
    '/api/v2/device-providers', '/api/v2/devices'];
  const services = createProductPlatformServices({
    baseUrl: 'http://workspace-suite-dom.invalid', panelTarget: () => null, workspaceStorage: null,
    ...(slots ? { slotAdapter: slots, decorateWorkspaceMount: legacyRouteSurfaces(() => extensionAccess) } : {}),
    transport: async (input, init) => {
      const path = requestUrl(input).pathname, method = init?.method ?? 'GET';
      requests.push(`${method} ${path}`);
      if (method === 'GET' && [...directoryPaths, '/api/v2/operations'].includes(path)) return success([]);
      if (method === 'GET' && path === `/api/v2/artifacts/${artifactId}`) return success({
        id: artifactId, filename: '归档界面验证.txt', media_type: 'text/plain',
        size: 12, sha256: 'a'.repeat(64), created_at: 1,
      });
      unexpected.push(`${method} ${path}`);
      throw new Error(`归档 DOM 单元没有授权此业务请求：${method} ${path}`);
    },
  });
  extensionAccess = services.runtime.extensions;
  const runtime = services.runtime, ui = runtime.host.ui, points = runtime.host.extensions?.points;
  assert.ok(ui && points);
  const shell = createShellHost({
    context: runtime.host, target,
    providerReady: (id, generation) => runtime.webPlugins.diagnosticSnapshot()
      .some((entry) => entry.id === id && entry.generation === generation && entry.state === 'loaded'),
  });
  async function until(predicate: () => boolean, message: string) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline)
      await act(async () => { await new Promise<void>((accept) => setTimeout(accept, 5)); });
    assert.ok(predicate(), `${message}；当前正文：${target.textContent?.slice(-1800) ?? ''}`);
  }
  async function load(plugin: WebPlugin) {
    runtime.bundledPlugins.register({ id: plugin.id, plugin, trusted: true });
    await act(async () => { await runtime.webPlugins.load(plugin.id); });
    assert.equal(runtime.webPlugins.diagnosticSnapshot().find((entry) => entry.id === plugin.id)?.state, 'loaded');
  }
  async function unload(id: string) {
    await act(async () => { await runtime.webPlugins.unload(id); });
  }
  async function fromArchive(directory: string, id: string) {
    const component = await browserComponent(directory, join(temporary, id));
    assert.equal(component.id, id);
    const plugin = readPluginModule(await import(pathToFileURL(component.entry).href));
    assert.equal(plugin.id, component.id);
    assert.equal(plugin.version, component.version);
    return { component, plugin };
  }
  const frame = (id: string) =>
    target.querySelector<HTMLElement>(`[data-workspace-canvas] [data-shell-instance="${id}"]`);
  function mounted(id: string): HTMLElement {
    const current = frame(id);
    assert.ok(current, `当前页面缺少实际实例 DOM：${id}`);
    return current;
  }
  async function navigate(route: string, instanceId: string) {
    await act(async () => {
      browser.window.history.replaceState(null, '', `#${route}`);
      browser.window.dispatchEvent(new browser.window.HashChangeEvent('hashchange'));
    });
    await until(() => frame(instanceId) !== null, `真实默认外壳未切换到${route}`);
  }
  async function type(input: HTMLInputElement, value: string) {
    const set = Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(set);
    await act(async () => {
      set.call(input, value);
      input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
    });
    assert.equal(input.value, value);
  }
  async function dispose() {
    try {
      await act(async () => {
        try { await shell.dispose(); }
        finally {
          try { await services.dispose(); }
          finally {
            try { await slots?.dispose(); }
            finally { await releasePublicUi(); }
          }
        }
      });
    } finally {
      parser.dispose();
      browser.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      assert.equal(dirname(resolve(temporary)), resolve(artifacts));
      assert.ok(resolve(temporary).startsWith(resolve(artifacts) + sep));
      await rm(temporary, { recursive: true, force: true });
    }
  }
  try {
    assert.deepEqual(parser.diagnostics, []);
    releasePublicUi = installPublicUi();
    for (const id of ['deviceforge_shell', 'deviceforge_devices', 'deviceforge_files']) {
      const releases: readonly unknown[] = officialReport.releases;
      const matches = releases.filter((entry) => object(entry) && entry.id === id);
      assert.equal(matches.length, 1, `本批官方报告必须唯一包含${id}`);
      const declaration = matches[0];
      assert.ok(object(declaration) && typeof declaration.archive === 'string' &&
        typeof declaration.bytes === 'number' && typeof declaration.sha256 === 'string');
      assert.ok(inside(dirname(officialPath), declaration.archive));
      const { component, plugin } = await fromArchive(dirname(declaration.archive), id);
      assert.equal(component.archivePath, resolve(declaration.archive));
      assert.equal(component.packed.size, declaration.bytes);
      assert.equal(component.packed.sha256, declaration.sha256);
      await load(plugin);
    }
    const suiteDirectory = resolve(dirname(suitePath), suiteReport.suiteDirectory);
    const contributorDirectory = resolve(dirname(suitePath), suiteReport.contributorDirectory);
    assert.ok(inside(dirname(suitePath), suiteDirectory) && inside(dirname(suitePath), contributorDirectory));
    const suite = await fromArchive(suiteDirectory, suiteId);
    const contributor = await fromArchive(contributorDirectory, contributorId);
    // 外壳按平台已选提供者装配；业务贡献只通过插件启用触发，不调用 attach 或写布局。
    await act(async () => { points.select(SHELL_POINT, 'deviceforge_shell.shell'); });
    await until(() => shell.snapshot().state === 'ready' && Boolean(frame(originalFileId)?.querySelector('input')),
      '实际默认外壳与原文件页面没有完成挂载');
    return { act, browser, document, target, services, runtime, ui, points, shell,
      suite, contributor, requests, unexpected, until, load, unload, frame, mounted, navigate, type, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

test('真实ZIP外壳候选失败保留原界面，完整委托切换及独立恢复只撤自有资格',
  { skip: requiredReports ? false : '需要明确指定当前官方及示例最终归档', timeout: 25_000 }, async (t) => {
    const f = await fixture();
    const shellPoint = { id: 'host.shell', version: '1' };
    try {
      const extensions = f.runtime.host.extensions;
      assert.ok(extensions);
      await f.load(f.suite.plugin);
      await f.load({ id: 'shell_region_probe', version: '1', apiVersion: 2, panels: [],
        async activate(context) {
          assert.ok(context.ui && context.extensions?.points);
          for (const region of ['header', 'footer']) {
            const viewId = `shell_region_probe.${region}`;
            context.ui.register({ views: [{ id: viewId, title: `外壳${region}单元贡献`,
              async mount(target) {
                const node = target.ownerDocument.createElement('span');
                node.setAttribute('data-shell-region-probe', region);
                node.textContent = `真实扩展${region}`; target.append(node);
                return () => { node.remove(); };
              },
            }] });
            context.extensions.points.contribute({ id: `${viewId}.contribution`,
              point: { id: `deviceforge_shell.${region}`, version: '1' },
              data: { pluginId: 'shell_region_probe', viewId }, mode: 'append' });
          }
        },
      });
      await f.until(() => f.target.querySelectorAll('[data-shell-region-probe]').length === 2,
        '外壳头尾探针必须先由原外壳实际挂载');
      const original = f.points.selected(shellPoint);
      assert.ok(original);
      const originalId = f.shell.snapshot().active?.id;
      const input = fileInput(f.mounted(originalFileId));
      await f.type(input, '完整外壳失败前原文件草稿');
      const start = async (behavior: 'delegate' | 'fail') => {
        const result = await extensions.executeCommand(`${suiteId}.shell-replacement.start`, {
          expected: { id: original.id, pluginId: original.provider.pluginId, generation: original.provider.generation },
          behavior,
        }, f.runtime.host.signal);
        assert.ok(object(result.data) && typeof result.data.replacementId === 'string' &&
          typeof result.data.contributionId === 'string');
        return result.data;
      };
      let failed: Record<string, JsonValue> | null = null;
      await f.act(async () => { failed = await start('fail'); });
      assert.ok(failed);
      const failedReceipt: Record<string, JsonValue> = failed;
      await f.until(() => f.shell.snapshot().state === 'failed', '外壳候选失败未交给原宿主裁定');
      assert.equal(f.shell.snapshot().active?.id, originalId);
      assert.ok(fileInput(f.mounted(originalFileId)) === input, '准备失败不能拆除原文件输入根');
      assert.equal(input.value, '完整外壳失败前原文件草稿');
      assert.match(f.shell.snapshot().error ?? '', /示例外壳候选按要求失败/);
      await f.act(async () => { await extensions.executeCommand(`${suiteId}.shell-replacement.restore`,
        { replacementId: failedReceipt.replacementId ?? null }, f.runtime.host.signal); });
      await f.until(() => f.shell.snapshot().state === 'ready' && f.shell.snapshot().active?.id === originalId,
        '恢复失败候选后原外壳没有保留');
      let successful: Record<string, JsonValue> | null = null;
      await f.act(async () => { successful = await start('delegate'); });
      assert.ok(successful);
      const successReceipt: Record<string, JsonValue> = successful;
      await f.until(() => f.shell.snapshot().state === 'ready' &&
        f.shell.snapshot().active?.id === successReceipt.contributionId, '完整委托外壳未切换成功');
      await f.until(() => Boolean(f.frame(originalFileId)?.querySelector('input')),
        '完整候选必须包含真实业务视图，不能只挂空外壳');
      assert.equal(f.target.querySelectorAll('[aria-label="工作区导航"]').length, 1);
      await f.until(() => f.target.querySelectorAll('[data-shell-region-probe]').length === 2,
        '新外壳必须各自挂载真实头尾贡献，不得用旧根或错误提示代替');
      assert.doesNotMatch(f.target.textContent ?? '', /视图实例标识已经在使用/);
      const status = await extensions.executeCommand(`${suiteId}.shell-replacement.status`,
        { replacementId: successReceipt.replacementId ?? null }, f.runtime.host.signal);
      assert.ok(object(status.data));
      assert.equal(status.data.mount, 'ready');
      assert.equal(status.data.selected, true);
      // 提供者卸载撤资格；恢复入口仍能显式选择原外壳，不要求候选自行写回选择。
      await f.unload(suiteId);
      await f.until(() => f.shell.snapshot().state === 'empty', '卸载完整外壳提供者后旧根未撤销');
      assert.equal(f.target.querySelector('[aria-label="工作区导航"]'), null);
      assert.deepEqual(f.shell.snapshot().cleanupErrors, [],
        `撤销委托外壳必须完成本代资源回收：${inspect(f.runtime.webPlugins.workspaceCleanupSnapshot(), { depth: 9 })}`);
      await f.act(async () => { f.points.select(shellPoint, original.id); f.shell.retry(); });
      await f.until(() => f.shell.snapshot().state === 'ready' &&
        Boolean(f.frame(originalFileId)?.querySelector('input')), '独立平台恢复入口未能重新显示官方外壳');
      assert.equal(f.shell.snapshot().active?.id, originalId);
      assert.equal(f.target.querySelectorAll('[aria-label="工作区导航"]').length, 1);
      await f.until(() => f.target.querySelectorAll('[data-shell-region-probe]').length === 2,
        '独立恢复后头尾贡献必须仍可挂载');
      assert.doesNotMatch(f.target.textContent ?? '', /视图实例标识已经在使用/);
      assert.deepEqual(f.unexpected, []);
      assert.equal(f.requests.filter((request) => request === 'GET /api/v2/device-providers').length, 1);
      assert.equal(f.requests.filter((request) => request === 'GET /api/v2/devices').length, 1);
      t.diagnostic('实际最终ZIP→公开host.shell贡献→原宿主准备/切换；失败保旧根，成功显示真实文件业务，卸载后显式独立恢复。');
      t.diagnostic('不承诺外壳卸载后保留已销毁React闭包草稿，不把JSDOM当浏览器视觉或在线安装证据。');
    } finally { await f.dispose(); }
  });

test('本批最终ZIP经真实默认外壳自动扩展设备文件页，跨页保留草稿且停用只撤自有贡献',
  { skip: requiredReports ? false : '需要同时指定本批官方与配套发行报告，不以源码或历史包替代',
    timeout: 25_000 }, async (t) => {
    const f = await fixture();
    try {
      assert.ok(f.target.querySelector('[aria-label="工作区导航"]'), '必须使用真实默认外壳导航');
      const original = f.frame(originalFileId);
      assert.ok(original);
      const originalInput = fileInput(original);
      await f.type(originalInput, '原文件页尚未提交的草稿');
      assert.equal(button(original, '打开文件').disabled, false, '草稿输入必须触发实际 React 状态');
      const baselineFileLayout = structuredClone(f.ui.readLayout(fileWorkspace));
      const baselineDeviceLayout = structuredClone(f.ui.readLayout(deviceWorkspace));
      const originalGeneration = f.ui.snapshot().instances.find((entry) =>
        entry.instanceId === originalFileId)?.generation;
      const toolPoint = { id: `${suiteId}.tools`, version: '1' };
      await f.load(f.contributor.plugin);
      assert.equal(f.points.list(toolPoint).find((entry) =>
        entry.provider.pluginId === contributorId)?.state, 'waiting',
      '贡献归档可以先加载，等待提供者公开扩展点');
      await f.load(f.suite.plugin);
      const fileTools = contributed(f.ui, fileWorkspace), deviceTools = contributed(f.ui, deviceWorkspace);
      assert.equal(fileTools.length, 1, '启用真实 suite 归档必须自动追加文件页贡献');
      assert.equal(deviceTools.length, 1, '启用真实 suite 归档必须自动追加设备页贡献');
      const fileTool = fileTools[0], deviceTool = deviceTools[0];
      assert.ok(fileTool && deviceTool);
      await f.until(() => Boolean(f.frame(fileTool.instanceId)?.querySelector('[aria-label="文件与产物"]')),
        '真实 suite 文件页贡献没有经 ui.mount 显示委托文件视图');
      const fileFrame = f.frame(fileTool.instanceId);
      assert.ok(fileFrame);
      const suiteFileInput = fileInput(fileFrame);
      const inputOwner = (input: HTMLInputElement) => ({
        workspace: input.closest('[data-deviceforge-workspace-instance]')
          ?.getAttribute('data-deviceforge-workspace-instance') ?? null,
        shell: input.closest('[data-shell-view]')?.getAttribute('data-shell-view') ?? null,
      });
      const frameRoots = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(
        '[data-deviceforge-workspace-instance], [data-shell-view]',
      )].map((element) => ({
        workspace: element.getAttribute('data-deviceforge-workspace-instance'),
        shell: element.getAttribute('data-shell-view'),
      }));
      const fileOwnerBeforeNavigation = inputOwner(suiteFileInput);
      await f.type(suiteFileInput, '组合文件页独立草稿');
      assert.equal(f.frame(originalFileId)?.querySelector('input[placeholder="任务结果中的 UUID"]'), originalInput);
      assert.equal(originalInput.value, '原文件页尚未提交的草稿',
        '自动追加布局不得重置既有业务视图');
      assert.equal(f.target.querySelectorAll('[data-workspace-canvas] [aria-label="文件与产物"]').length, 2);
      const contribution = f.points.list(toolPoint).find((entry) => entry.provider.pluginId === contributorId);
      assert.equal(contribution?.state, 'active');
      assert.deepEqual(contribution?.data, {
        title: '读取配套示例数据', commandId: `${contributorId}.read-provider`,
      });
      const extensions = f.runtime.host.extensions;
      assert.ok(extensions);
      const listed = await extensions.executeCommand(`${suiteId}.tools`, {}, f.runtime.host.signal);
      assert.ok(Array.isArray(listed.data) && listed.data.some((entry: JsonValue) =>
        object(entry) && entry.id === contribution?.id && entry.state === 'active'),
      '真实提供者必须能从自身公开消费者命令读到第二插件的扩展点内容');
      const read = await extensions.executeCommand(`${contributorId}.read-provider`, {}, f.runtime.host.signal);
      assert.ok(object(read.data) && object(read.data.value));
      assert.deepEqual(read.data.value, { message: '' },
        '真实贡献命令必须通过原服务链读取 suite 自有消息服务');
      const status = await extensions.executeCommand(`${contributorId}.status`, {}, f.runtime.host.signal);
      assert.ok(object(status.data));
      assert.equal(status.data.active, true);
      assert.equal(status.data.completedReads, 1);

      await f.navigate('/devices', 'deviceforge_devices.workbench.main');
      await f.until(() => Boolean(f.frame(deviceTool.instanceId)?.querySelector('[aria-label="文件与产物"]')),
        '真实设备页没有自动显示同一 suite 提供的内容');
      const workbench = f.target.querySelector('[aria-label="设备工作台"]');
      assert.ok(workbench);
      assert.match(workbench.textContent ?? '', /还没有可用的设备提供者/);
      const deviceFrame = f.frame(deviceTool.instanceId);
      assert.ok(deviceFrame);
      const suiteDeviceInput = fileInput(deviceFrame);
      t.diagnostic(JSON.stringify({
        fileInstance: fileTool.instanceId, deviceInstance: deviceTool.instanceId,
        fileOwnerBeforeNavigation,
        fileInputOwner: inputOwner(suiteFileInput),
        deviceInputOwner: inputOwner(suiteDeviceInput),
        capturedFileFrameNow: fileFrame.getAttribute('data-shell-instance'),
        deviceFrameNow: deviceFrame.getAttribute('data-shell-instance'),
        sameFrame: fileFrame === deviceFrame,
        capturedFileFrameRoots: frameRoots(fileFrame), deviceFrameRoots: frameRoots(deviceFrame),
        fileDraftBeforeDeviceEdit: suiteFileInput.value,
      }));
      assert.deepEqual([...deviceFrame.querySelectorAll('[data-shell-view]')].map((element) =>
        element.getAttribute('data-shell-view')), [deviceTool.instanceId],
      '页面 frame 复用时必须先移走上一页挂载根，不能在当前贡献中混入旧页文件视图');
      assert.notEqual(suiteDeviceInput, suiteFileInput,
        `跨页贡献必须使用独立输入节点；文件实例=${fileTool.instanceId}，设备实例=${deviceTool.instanceId}`);
      await f.type(suiteDeviceInput, '组合设备页独立草稿');
      for (let turn = 0; turn < 2; turn++) {
        await f.navigate('/files', originalFileId);
        assert.equal(fileInput(f.mounted(originalFileId)), originalInput);
        assert.equal(originalInput.value, '原文件页尚未提交的草稿');
        assert.equal(fileInput(f.mounted(fileTool.instanceId)), suiteFileInput);
        assert.equal(suiteFileInput.value, '组合文件页独立草稿');
        assert.equal(f.target.querySelectorAll('[data-workspace-canvas] [aria-label="文件与产物"]').length, 2);
        await f.navigate('/devices', 'deviceforge_devices.workbench.main');
        assert.equal(f.target.querySelector('[data-workspace-canvas] [aria-label="设备工作台"]'), workbench);
        assert.equal(fileInput(f.mounted(deviceTool.instanceId)), suiteDeviceInput);
        assert.equal(suiteDeviceInput.value, '组合设备页独立草稿');
        assert.deepEqual(contributed(f.ui, fileWorkspace).map((entry) => entry.instanceId), [fileTool.instanceId]);
        assert.deepEqual(contributed(f.ui, deviceWorkspace).map((entry) => entry.instanceId), [deviceTool.instanceId]);
        assert.equal(f.target.querySelectorAll('[data-workspace-canvas] [aria-label="文件与产物"]').length, 1);
      }
      await f.unload(contributorId);
      assert.equal(f.points.list(toolPoint).some((entry) => entry.provider.pluginId === contributorId), false);
      assert.equal(f.frame(deviceTool.instanceId)?.querySelector('input[placeholder="任务结果中的 UUID"]'),
        suiteDeviceInput, '撤销命令贡献不得拆除另一插件的已挂载视图');
      assert.equal(suiteDeviceInput.value, '组合设备页独立草稿');
      await f.unload(suiteId);
      await f.until(() => f.frame(deviceTool.instanceId) === null &&
        contributed(f.ui, deviceWorkspace).length === 0 && contributed(f.ui, fileWorkspace).length === 0,
      '停用 suite 后应撤销它的跨页自有贡献');
      assert.deepEqual(f.ui.readLayout(fileWorkspace), baselineFileLayout);
      assert.deepEqual(f.ui.readLayout(deviceWorkspace), baselineDeviceLayout);
      assert.equal(f.target.querySelector('[data-workspace-canvas] [aria-label="设备工作台"]'), workbench);
      assert.equal(f.target.querySelectorAll('[data-workspace-canvas] [aria-label="文件与产物"]').length, 0);
      await f.navigate('/files', originalFileId);
      assert.equal(fileInput(f.mounted(originalFileId)), originalInput);
      assert.equal(originalInput.value, '原文件页尚未提交的草稿');
      assert.equal(f.ui.snapshot().instances.find((entry) =>
        entry.instanceId === originalFileId)?.generation, originalGeneration);
      await f.type(originalInput, artifactId);
      await f.act(async () => { button(f.mounted(originalFileId), '打开文件').click(); });
      await f.until(() => Boolean(f.frame(originalFileId)?.textContent?.includes('归档界面验证.txt')),
        '撤销扩展后原文件业务应仍可通过原通信链读取产物元数据');
      assert.equal(f.target.querySelectorAll('[data-workspace-canvas] [aria-label="文件与产物"]').length, 1);
      assert.equal(f.shell.snapshot().state, 'ready');
      assert.deepEqual(f.unexpected, []);
      assert.equal(f.requests.filter((request) => request === 'GET /api/v2/device-providers').length, 1);
      assert.equal(f.requests.filter((request) => request === 'GET /api/v2/devices').length, 1);
      assert.ok(f.requests.includes(`GET /api/v2/artifacts/${artifactId}`));
      t.diagnostic('JSDOM 挂载来源：本批最终 ZIP → 身份包装 → 原 runtime/UI/points → 真实默认外壳与设备/文件视图。');
      t.diagnostic('第二插件只声明工具命令元数据；已验证真实扩展点消费和服务调用，未宣称存在可视按钮。');
      t.diagnostic(`只读通信夹具：${f.requests.join('；')}。没有网络、设备、真实浏览器或视觉验收。`);
    } finally { await f.dispose(); }
  });

test('本批ZIP的公开路由替换完成真实挂载，撤回和候选失败均保留原文件草稿',
  { skip: requiredReports ? false : '需要明确的官方与配套归档报告，不能用源码替代', timeout: 25_000 }, async (t) => {
    const f = await fixture(true);
    const failures: unknown[] = [];
    try {
      const original = f.mounted(originalFileId), input = fileInput(original);
      await f.type(input, '路由替换前尚未提交的原文件草稿');
      const generation = f.ui.snapshot().instances.find((entry) => entry.instanceId === originalFileId)?.generation;
      await f.load(f.suite.plugin);
      const tool = contributed(f.ui, fileWorkspace)[0];
      assert.ok(tool);
      await f.until(() => Boolean(f.frame(tool.instanceId)?.querySelector('input')), '普通追加贡献没有完成原视图挂载');
      const independentInput = fileInput(f.mounted(tool.instanceId));
      await f.type(independentInput, '与整页替换无关的追加草稿');
      const extensions = f.runtime.host.extensions;
      assert.ok(extensions);
      const started: { value: JsonValue } = { value: null };
      await f.act(async () => {
        started.value = (await extensions.executeCommand(`${suiteId}.route-replacement.start`, {
          slot: 'route.files', expectedReplacement: null, behavior: 'files',
        }, f.runtime.host.signal)).data;
      });
      assert.ok(object(started.value) && typeof started.value.replacementId === 'string');
      const replacementId = started.value.replacementId;
      assert.equal(started.value.mount, 'not_observed', '命令登记回执不能预报实际挂载已完成');
      const candidate = () => f.target.querySelector<HTMLElement>(`[data-deviceforge-extension="${replacementId}"]`);
      await f.until(() => Boolean(candidate()?.querySelector('[aria-label="文件与产物"]')) &&
        input.closest('[hidden]') !== null, '真实候选完成后才允许隐藏原内容');
      const observed = await extensions.executeCommand(`${suiteId}.route-replacement.status`,
        { replacementId }, f.runtime.host.signal);
      assert.ok(object(observed.data));
      assert.equal(observed.data.mount, 'ready');
      assert.equal(observed.data.mountCount, 1);
      assert.ok(input.isConnected && f.mounted(originalFileId).contains(input), '成功替换时必须保留原输入节点');
      assert.equal(input.value, '路由替换前尚未提交的原文件草稿');
      await f.act(async () => {
        const restored = await extensions.executeCommand(`${suiteId}.route-replacement.restore`,
          { replacementId }, f.runtime.host.signal);
        assert.ok(object(restored.data));
        assert.equal(restored.data.registration, 'withdrawn');
      });
      await f.until(() => candidate() === null && input.closest('[hidden]') === null,
        '撤回自有替换后没有恢复原文件界面');
      assert.ok(fileInput(f.mounted(originalFileId)) === input, '撤回后必须复用原输入节点');
      assert.equal(input.value, '路由替换前尚未提交的原文件草稿');
      assert.ok(fileInput(f.mounted(tool.instanceId)) === independentInput, '撤回后保留无关追加草稿节点');
      assert.equal(independentInput.value, '与整页替换无关的追加草稿');
      const failed: { value: JsonValue } = { value: null };
      await f.act(async () => {
        failed.value = (await extensions.executeCommand(`${suiteId}.route-replacement.start`, {
          slot: 'route.files', expectedReplacement: null, behavior: 'fail',
        }, f.runtime.host.signal)).data;
      });
      assert.ok(object(failed.value) && typeof failed.value.replacementId === 'string');
      const failedReplacementId = failed.value.replacementId;
      await f.until(() => Boolean(f.target.textContent?.includes('示例候选视图按要求失败')) &&
        !f.runtime.webPlugins.diagnosticSnapshot().some((entry) => entry.id === suiteId && entry.state === 'loaded'),
      '候选真实失败必须保留原错误并由原管理器回滚该示例');
      assert.equal(input.closest('[hidden]'), null);
      assert.ok(fileInput(f.mounted(originalFileId)) === input, '候选失败不得重建原输入');
      assert.equal(input.value, '路由替换前尚未提交的原文件草稿');
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === originalFileId)?.generation, generation);
      assert.equal(f.target.querySelector(`[data-deviceforge-extension="${failedReplacementId}"]`), null,
        '失败半成品不得残留在当前页面');
      await f.act(async () => { await f.runtime.webPlugins.load(suiteId); });
      assert.equal(f.runtime.webPlugins.diagnosticSnapshot().find((entry) => entry.id === suiteId)?.state, 'loaded',
        '历史候选失败不能封锁原插件的新代独立加载');
      assert.ok(fileInput(f.mounted(originalFileId)) === input, '新代示例不得重建原输入');
      assert.equal(input.value, '路由替换前尚未提交的原文件草稿');
      assert.deepEqual(f.unexpected, []);
      t.diagnostic('真实ZIP→原槽位/管理器→文件视图；成功回读ready，撤回保原草稿，真实失败回落且允许新代加载。');
      t.diagnostic('JSDOM与只读通信夹具，不是在线安装、真实浏览器或视觉通过。');
    } catch (error) { failures.push(error); }
    finally {
      const cleanupLeaves = (error: unknown): readonly unknown[] => error instanceof AggregateError
        ? error.errors.flatMap(cleanupLeaves) : [error];
      for (const entry of f.runtime.webPlugins.cleanupSnapshot())
        t.diagnostic(`管理器原清理诊断：${inspect(cleanupLeaves(entry.error), { depth: 3 })}`);
      try { await f.dispose(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const leafErrors = (error: unknown): readonly unknown[] => error instanceof AggregateError
        ? error.errors.flatMap(leafErrors) : [error];
      t.diagnostic(inspect(failures.flatMap(leafErrors), { depth: 4 }));
      throw new AggregateError(failures, '路由替换核对或自有夹具回收失败，保留两者原错');
    }
  });
