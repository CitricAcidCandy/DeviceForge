import { useLayoutEffect, useState } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import type { AiServices } from './services.ts';
import { AiProviderPanel } from './view/AiProviderPanel.tsx';

export function AiPage({ services, instance }: { services: AiServices; instance: WorkspaceViewContext }) {
  const [provider, setProvider] = useState(services.selection.provider);
  const [visible, setVisible] = useState(true);
  useLayoutEffect(() => {
    let disposed = false;
    let previous: boolean | undefined;
    const update = (visible: boolean) => {
      if (disposed) return;
      if (!visible && previous !== false) services.stopWatching();
      previous = visible;
      setVisible(visible);
    };
    const release = instance.subscribeVisibility(update);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      void Promise.resolve().then(release).catch(() => undefined);
    };
    // 父视图可能在订阅登记前隐藏；校准当前事实，不自动恢复或重放会话操作。
    try { update(instance.snapshot().visible); }
    catch (error) { dispose(); throw error; }
    return dispose;
  }, [instance, services]);
  return (
    <div hidden={!visible} inert={!visible} className="@container/ai-page h-full min-h-0 min-w-0 w-full overflow-hidden">
    <section className="@container/ai flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden w-full px-6 pb-7 pt-[22px] @max-[900px]/ai-page:px-4 @max-[900px]/ai-page:pb-6 @max-[900px]/ai-page:pt-4" data-product-page="ai">
      {(['sdk', 'cli'] satisfies ('sdk' | 'cli')[]).map((item) => (
        <div key={item} hidden={provider !== item} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AiProviderPanel services={services} provider={item}
            visible={visible && provider === item}
            instanceId={instance.snapshot().instanceId}
            onProviderChange={(next) => { services.selection.provider = next; setProvider(next); }} />
        </div>
      ))}
    </section>
    </div>
  );
}
export function mountAi(target: HTMLElement, services: AiServices, instance: WorkspaceViewContext) {
  return hostUi().mountReact(target, <AiPage services={services} instance={instance} />);
}
