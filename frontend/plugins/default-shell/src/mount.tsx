import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Dispose, HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { createMountPool } from './mount-pool.ts';
import { createShellController, normalizeRoute } from './controller.ts';
import { Shell } from './shell.tsx';
import { ShellRenderBoundary } from './render-boundary.tsx';

export async function mountShell(target: HTMLElement, context: HostContext, instance?: WorkspaceViewContext): Promise<Dispose> {
  const ui = context.ui;
  if (!ui?.mount) throw new Error('当前平台未提供公开工作区渲染能力');
  const cancellation = new AbortController();
  const signal = AbortSignal.any([context.signal, cancellation.signal]);
  const container = target.ownerDocument.createElement('div');
  container.className = 'relative h-full min-h-0 w-full';
  const content = target.ownerDocument.createElement('div');
  content.className = 'h-full min-h-0 w-full';
  const staging = target.ownerDocument.createElement('div');
  staging.className = 'pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-0';
  staging.setAttribute('aria-hidden', 'true');
  staging.inert = true;
  container.append(content, staging); target.append(container);
  const pool = createMountPool(ui, target.ownerDocument, signal, staging);
  const lifecycle = context.extensions?.subscribeEvent('host.plugins.changed', (event) => {
    const data = event.data;
    if (data && typeof data === 'object' && !Array.isArray(data) &&
      'stage' in data && data.stage === 'loaded' && 'pluginId' in data && typeof data.pluginId === 'string')
      pool.providerLoaded(data.pluginId);
  });
  const controller = createShellController(context, pool, target.ownerDocument.defaultView?.location.hash ?? '/',
    // 默认首页是这个外壳插件的产品策略，不由宿主枚举，也不等待配置读写。
    '/devices');
  let releaseAddress: Dispose = () => {};
  let releaseVisibility: Dispose = () => {};
  const alignHomeAddress = () => {
    if (signal.aborted || instance?.signal.aborted || instance && !instance.snapshot().visible) return;
    const window = target.ownerDocument.defaultView;
    const route = controller.snapshot().route;
    if (!window || normalizeRoute(window.location.hash) !== '/' || route === '/') return;
    const oldURL = window.location.href;
    // 仅补齐实际生效的空首页；不增加后退历史、不在替换准备区改动现用外壳地址。
    window.history.replaceState(window.history.state, '', `#${route}`);
    window.dispatchEvent(new window.HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
  };
  let renderError: unknown;
  const report = (error: Error) => {
    renderError = error;
    try { context.debug?.emit({ name: 'shell.render.failed', metadata: { message: error.message } }); }
    catch { /* 调试订阅失效不应使故障回退本身再次崩溃。 */ }
  };
  const root = createRoot(content, {
    onUncaughtError(error) { renderError = error; },
    onCaughtError() { /* 错误边界负责展示并写入当前插件的调试事件。 */ },
  });
  let released = false;
  const dispose = async () => {
    if (released) return;
    released = true;
    cancellation.abort();
    await releaseAddress();
    await releaseVisibility();
    await lifecycle?.();
    controller.dispose();
    root.unmount();
    await pool.dispose();
    container.remove();
  };
  try {
    flushSync(() => root.render(<ShellRenderBoundary onFailure={report}>
      <Shell context={context} controller={controller} pool={pool} />
    </ShellRenderBoundary>));
    if (renderError) throw renderError;
    releaseAddress = controller.subscribe(alignHomeAddress);
    releaseVisibility = instance?.subscribeVisibility(alignHomeAddress) ?? (() => {});
    alignHomeAddress();
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
