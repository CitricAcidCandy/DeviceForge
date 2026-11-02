import { useEffect, useState } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import type { AiServices } from './services.ts';
import { AiProviderPanel } from './view/AiProviderPanel.tsx';

export function AiPage({ services, instance }: { services: AiServices; instance: WorkspaceViewContext }) {
  const [provider, setProvider] = useState(services.selection.provider);
  useEffect(() => {
    const release = instance.subscribeVisibility((visible) => { if (!visible) services.stopWatching(); });
    return () => { void release(); };
  }, [instance, services]);
  return (
    <section className="@container/ai flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-product-page="ai">
      {(['sdk', 'cli'] satisfies ('sdk' | 'cli')[]).map((item) => (
        <div key={item} hidden={provider !== item} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AiProviderPanel services={services} provider={item}
            instanceId={instance.snapshot().instanceId}
            onProviderChange={(next) => { services.selection.provider = next; setProvider(next); }} />
        </div>
      ))}
    </section>
  );
}
export function mountAi(target: HTMLElement, services: AiServices, instance: WorkspaceViewContext) {
  return hostUi().mountReact(target, <AiPage services={services} instance={instance} />);
}
