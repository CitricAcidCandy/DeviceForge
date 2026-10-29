import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { createMountPool } from './mount-pool.ts';
import { createShellController } from './controller.ts';
import { Shell } from './shell.tsx';

export async function mountShell(target: HTMLElement, context: HostContext): Promise<Dispose> {
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
  const controller = createShellController(context, pool, target.ownerDocument.defaultView?.location.hash ?? '/');
  let renderError: unknown;
  const root = createRoot(content, { onUncaughtError(error) { renderError = error; } });
  let released = false;
  const dispose = async () => {
    if (released) return;
    released = true;
    cancellation.abort();
    await lifecycle?.();
    controller.dispose();
    root.unmount();
    await pool.dispose();
    container.remove();
  };
  try {
    flushSync(() => root.render(<Shell context={context} controller={controller} pool={pool} />));
    if (renderError) throw renderError;
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
