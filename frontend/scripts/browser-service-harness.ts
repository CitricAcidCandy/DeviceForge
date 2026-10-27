import { createFrontendRuntime, createNamedSlotAdapter } from '/__production_host__';
import { installPublicUi } from '../src/app/public-ui.ts';
import type { JsonValue, ServiceFeatureDiagnostic } from '../src/plugin-sdk/index.ts';

const providerId = 'example.service-provider';
const consumerId = 'example.service-consumer';
const echoId = `${providerId}.echo`;
const pageId = `${consumerId}.page`;
const widgetId = `${consumerId}.widget`;
const independentId = `${consumerId}.independent`;
const independentCommandId = `${consumerId}.independent-command`;
const independentPageId = `${consumerId}.independent-page`;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function generation(value: unknown): number {
  check(object(value) && typeof value['generation'] === 'number', '启用结果缺少运行代际');
  return value['generation'];
}
function target(id: string): HTMLElement {
  const root = document.createElement('section');
  root.id = id;
  document.body.append(root);
  return root;
}
async function eventually(read: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
function diagnostics(value: JsonValue): readonly ServiceFeatureDiagnostic[] {
  check(Array.isArray(value), '诊断命令没有返回功能列表');
  // 只核对本验收所消费的公开字段，不把插件返回值断言为宿主内部类型。
  return value.map((entry) => {
    check(object(entry) && typeof entry['featureId'] === 'string', '功能诊断标识无效');
    const state = entry['state'];
    check(state === 'waiting' || state === 'starting' || state === 'active' || state === 'failed' || state === 'stopped', '功能诊断状态无效');
    check(Array.isArray(entry['missing']) && Array.isArray(entry['cleanupErrors']), '功能诊断缺少依赖或清理历史');
    const missing = entry['missing'].map((ref: unknown) => {
      check(object(ref) && typeof ref['id'] === 'string' && typeof ref['version'] === 'string', '缺失服务引用无效');
      return { id: ref['id'], version: ref['version'] };
    });
    check(entry['error'] === null || typeof entry['error'] === 'string', '功能诊断错误无效');
    check(entry['cleanupErrors'].length === 0, '本轮功能存在清理失败');
    return { featureId: entry['featureId'], state, missing, error: entry['error'], cleanupErrors: [] };
  });
}

// 这里只上传归档、导入真实运行 URL 和消费公开宿主；插件贡献来自两个独立安装包。
export async function verifyServiceComposition() {
  const startedAt = new Date().toISOString();
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  const imports: string[] = [];
  const observations: Record<string, unknown> = {};
  const roots = [target('service-widget'), target('service-page'), target('independent-widget'), target('independent-page')];
  const [widget, page, independent, independentPage] = roots;
  check(widget && page && independent && independentPage, '验收挂载点创建失败');
  let activeCheck = '初始化生产宿主';
  let failed = false;
  let runtime: ReturnType<typeof createFrontendRuntime> | undefined;
  let slots: Awaited<ReturnType<typeof createNamedSlotAdapter>> | undefined;
  const uninstallUi = installPublicUi();
  const signal = AbortSignal.timeout(45000);
  const record = (name: string) => { checks.push({ name, passed: true }); };
  const runCheck = async (name: string, action: () => Promise<void>) => {
    activeCheck = name;
    await action();
    record(name);
  };
  try {
    slots = await createNamedSlotAdapter([
      { id: 'workspace.sidebar', target: widget },
      { id: 'service.independent', target: independent },
    ]);
    runtime = createFrontendRuntime({
      baseUrl: location.origin,
      transport: fetch.bind(globalThis),
      panelTarget: () => null,
      moduleTarget: (id) => id === independentPageId ? independentPage : page,
      slotAdapter: slots,
      esmImporter: async (url, current) => {
        current.throwIfAborted();
        check(/^\/api\/v2\/browser-plugins\/[^/]+\/runs\/[^/]+\/assets\//u.test(url), '插件没有使用安装后的运行 URL');
        imports.push(url);
        return import(/* @vite-ignore */ url);
      },
      packageEntryResolver: (info, runId) =>
        `/api/v2/browser-plugins/${encodeURIComponent(info.id)}/runs/${runId}/assets/${info.entryPath}`,
    });
    const current = runtime;
    const feature = async () => {
      const reply = await current.extensions.executeCommand(`${consumerId}.diagnostics`, null, signal);
      const entry = diagnostics(reply.data).find((item) => item.featureId === 'echo-workspace');
      check(entry, '消费者没有公开组合功能诊断');
      return entry;
    };
    const composed = () => {
      const catalog = current.extensions.catalog();
      return catalog.modules.some((entry) => entry.id === pageId) &&
        catalog.components.some((entry) => entry.id === widgetId) &&
        catalog.commands.some((entry) => entry.id === `${consumerId}.echo`);
    };
    await runCheck('上传两个独立浏览器TGZ', async () => {
      for (const [kind, id] of [['provider', providerId], ['consumer', consumerId]]) {
        check(kind && id, '归档计划无效');
        const response = await fetch(`/__fixture__/${kind}.tgz`, { signal });
        check(response.ok, '独立归档读取失败');
        const reply = await current.pluginPackages.upload('browser', await response.blob(), 'application/gzip', signal);
        check(reply.data.id === id, '安装目录与独立示例身份不符');
      }
      check((await current.pluginPackages.refresh('browser', signal)).data.length === 2, '真实安装目录没有两个包');
    });
    let consumerGeneration = 0;
    await runCheck('缺少提供者时仅组合功能等待', async () => {
      consumerGeneration = generation((await current.pluginPackages.enable('browser', consumerId, signal)).data);
      await eventually(async () => (await feature()).state === 'waiting', '缺少服务时组合功能没有等待');
      const snapshot = await feature();
      check(snapshot.missing.some((ref) => ref.id === echoId && ref.version === '1'), '诊断没有标明缺失的精确服务引用');
      check(!composed(), '缺少提供者时发布了组合贡献');
      observations['waiting'] = snapshot;
      await current.extensions.mountComponent(independentId);
      await current.extensions.mountModule(independentPageId);
      check((await current.extensions.executeCommand(independentCommandId, null, signal)).data === '独立功能仍可用', '独立命令被缺失服务阻塞');
    });
    const independentButton = independent.querySelector('button');
    check(independentButton instanceof HTMLButtonElement, '独立 React 组件没有实际挂载');
    await runCheck('React命名入口复用宿主且hooks和portal可用', async () => {
      for (const id of [consumerId]) {
        const probe = await current.extensions.executeCommand(`${id}.react-probe`, null, signal);
        check(object(probe.data), 'React 共享入口探针没有返回对象');
        for (const name of ['react', 'client', 'dom', 'jsx', 'dev']) check(probe.data[name] === true, `${name} 没有复用宿主实例`);
        observations[`${id}.react`] = probe.data;
      }
      check(independentButton.textContent === '共享计数：0', 'React 初始状态无效');
      independentButton.click();
      await eventually(() => independentButton.textContent === '共享计数：1', '命名导入的 hooks 没有更新真实 DOM');
      check(independent.querySelector('[data-shared-portal]')?.textContent === '共享门户', '命名导入的 createPortal 没有渲染');
    });
    let firstProviderGeneration = 0;
    await runCheck('提供者上线后发布页面元数据与槽位', async () => {
      firstProviderGeneration = generation((await current.pluginPackages.enable('browser', providerId, signal)).data);
      await eventually(async () => composed() && (await feature()).state === 'active', '提供者上线后组合功能未激活');
      const catalog = current.extensions.catalog();
      const metadata = catalog.modules.find((entry) => entry.id === pageId);
      check(metadata?.title === '组合服务' && metadata.route === '/catalog' && metadata.pluginId === consumerId && metadata.generation === consumerGeneration, '动态页面元数据没有来自消费者当前代际');
      check(catalog.components.some((entry) => entry.id === widgetId && entry.slot === 'workspace.sidebar'), '组合组件没有声明公开槽位');
      const probe = await current.extensions.executeCommand(`${providerId}.react-probe`, null, signal);
      const shared = probe.data;
      check(object(shared), '独立提供者React探针必须返回对象');
      check(['react', 'client', 'dom', 'jsx', 'dev'].every((name) => shared[name] === true), '独立提供者没有复用宿主 React');
      observations['first_page'] = metadata;
      observations['active'] = await feature();
      await current.extensions.mountComponent(widgetId);
      await current.extensions.mountModule(pageId);
    });
    const originalButton = widget.querySelector('button');
    const originalPageButton = page.querySelector('button');
    check(originalButton instanceof HTMLButtonElement && originalPageButton instanceof HTMLButtonElement, '组合页面与槽位没有真实挂载');
    await runCheck('公开callTyped贯通两个独立包', async () => {
      originalButton.click();
      originalPageButton.click();
      await eventually(() => widget.querySelector('output')?.textContent === '组合服务已就绪' && page.querySelector('output')?.textContent === '组合服务已就绪', '组合页面没有完成公开服务调用');
      check((await current.extensions.executeCommand(`${consumerId}.echo`, null, signal)).data === '组合服务已就绪', '公开组合命令没有取得提供者结果');
    });
    await runCheck('提供者停用仅撤销相关贡献与DOM', async () => {
      await current.pluginPackages.disable('browser', providerId, signal);
      await eventually(async () => !composed() && (await feature()).state === 'waiting' && widget.childElementCount === 0 && page.childElementCount === 0, '提供者停用后组合贡献或 DOM 没有撤销');
      check(!originalButton.isConnected && !originalPageButton.isConnected, '旧组合挂载点仍在页面中');
      check(current.webPlugins.snapshot().some((entry) => entry.id === consumerId && entry.state === 'loaded' && entry.generation === consumerGeneration), '依赖失败卸载了消费者或改变其根代际');
      let rejected = false;
      try { await current.extensions.executeCommand(`${consumerId}.echo`, null, signal); } catch { rejected = true; }
      check(rejected, '已撤销的组合命令仍可调用');
      const missing = await feature();
      check(missing.missing.some((ref) => ref.id === echoId && ref.version === '1'), '提供者失效诊断没有保留缺失引用');
      observations['revoked'] = missing;
    });
    await runCheck('独立页面组件命令及React状态保留', async () => {
      const catalog = current.extensions.catalog();
      check(catalog.modules.some((entry) => entry.id === independentPageId) && catalog.components.some((entry) => entry.id === independentId), '提供者失效波及独立页面或组件');
      check(independent.querySelector('button') === independentButton && independentButton.textContent === '共享计数：1', '提供者失效重建或清空了独立 React 状态');
      check((await current.extensions.executeCommand(independentCommandId, null, signal)).data === '独立功能仍可用', '提供者失效阻塞独立命令');
      independentButton.click();
      await eventually(() => independentButton.textContent === '共享计数：2', '提供者失效后独立 React 挂载不可交互');
    });
    await runCheck('恢复提供者产生新运行URL与代际', async () => {
      const next = generation((await current.pluginPackages.enable('browser', providerId, signal)).data);
      check(next > firstProviderGeneration, '提供者恢复没有推进代际');
      await eventually(async () => composed() && (await feature()).state === 'active', '恢复后没有重建相关功能');
      const providerUrls = imports.filter((url) => url.includes(`/browser-plugins/${providerId}/`));
      check(providerUrls.length === 2 && new Set(providerUrls).size === 2, '提供者恢复命中旧运行 URL');
      check(current.webPlugins.snapshot().some((entry) => entry.id === consumerId && entry.generation === consumerGeneration), '服务恢复重载了消费者');
      observations['generations'] = { consumer: consumerGeneration, provider_first: firstProviderGeneration, provider_next: next };
      observations['restored'] = await feature();
    });
    await runCheck('恢复后重挂载新功能且旧节点不复活', async () => {
      await current.extensions.mountComponent(widgetId);
      await current.extensions.mountModule(pageId);
      const nextButton = widget.querySelector('button');
      check(nextButton instanceof HTMLButtonElement && nextButton !== originalButton && page.querySelector('button') !== originalPageButton, '恢复后复用了已撤销的挂载');
      check(widget.querySelector('output')?.textContent === '', '新功能带入旧挂载结果');
      originalButton.click();
      check(widget.querySelector('output')?.textContent === '', '旧节点影响了新功能');
      nextButton.click();
      await eventually(() => widget.querySelector('output')?.textContent === '组合服务已就绪', '新功能未使用恢复后的服务');
      check((await current.extensions.executeCommand(`${consumerId}.echo`, null, signal)).data === '组合服务已就绪', '恢复后的组合命令不可用');
      check(independent.querySelector('button') === independentButton && independentButton.textContent === '共享计数：2', '服务恢复丢失独立状态');
    });
    await runCheck('删除安装包撤销全部本轮贡献与挂载', async () => {
      await current.pluginPackages.remove('browser', consumerId, signal);
      await current.pluginPackages.remove('browser', providerId, signal);
      await eventually(() => roots.every((root) => root.childElementCount === 0), '卸载后仍有本轮 DOM');
      const catalog = current.extensions.catalog();
      check(Object.values(catalog).flat().every((entry) => entry.pluginId !== consumerId && entry.pluginId !== providerId), '卸载后仍有插件贡献');
      check(current.webPlugins.snapshot().length === 0, '卸载后仍有运行插件');
      check((await current.pluginPackages.refresh('browser', signal)).data.length === 0, '卸载后真实安装目录不为空');
    });
  } catch (error) {
    failed = true;
    checks.push({ name: activeCheck, passed: false, detail: error instanceof Error ? error.message : '未知浏览器验收错误' });
  } finally {
    for (const [name, release] of [
      ['生产宿主释放', async () => { await runtime?.dispose(); }],
      ['槽位适配器释放', async () => { await slots?.dispose(); }],
      ['公共UI与验收节点释放', async () => { uninstallUi(); roots.forEach((root) => root.remove()); }],
    ] satisfies readonly (readonly [string, () => Promise<void>])[]) {
      try { await release(); record(name); } catch (error) {
        failed = true;
        checks.push({ name, passed: false, detail: error instanceof Error ? error.message : '资源释放失败' });
      }
    }
  }
  return { passed: !failed, started_at: startedAt, completed_at: new Date().toISOString(), checks, imports, observations };
}
