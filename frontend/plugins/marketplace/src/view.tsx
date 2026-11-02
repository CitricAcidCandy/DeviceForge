import { useSyncExternalStore } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import type { MarketplaceController } from './model/index.ts';
import { MarketplacePage } from './workbench/index.tsx';
import { createMarketplaceServices } from './workbench/services.ts';
import type { MarketplaceServices } from './workbench/services.ts';

function Workbench({ services, instance }: { services: MarketplaceServices; instance: WorkspaceViewContext }) {
  const active = useSyncExternalStore(
    (listener) => { const release = instance.subscribeVisibility(listener); return () => { void release(); }; },
    () => instance.snapshot().visible,
  );
  return <MarketplacePage services={services} active={active} />;
}
export async function mountMarketplace(target: HTMLElement, context: HostContext, instance: WorkspaceViewContext, marketplace: MarketplaceController) {
  const services = createMarketplaceServices(context, marketplace);
  let release;
  try { release = hostUi().mountReact(target, <Workbench services={services} instance={instance} />); }
  catch (error) {
    try { await services.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], '市场视图挂载失败，清理也出现错误'); }
    throw error;
  }
  return async () => {
    try { await release(); }
    finally { await services.dispose(); }
  };
}
