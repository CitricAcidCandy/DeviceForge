import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProductPlatformServices } from '../product/platform-services.ts';
import { createShellHost } from './shell-host.ts';
import type { ShellHost } from './shell-host.ts';
import { PlatformRecovery } from './Recovery.tsx';
import { MessageProvider } from '../../components/Message/index.tsx';

/** 最小启动根只承载可替换外壳与独立恢复入口，不导入任何业务页面。 */
export function CompositionRoot({ services }: { readonly services: ProductPlatformServices }) {
  const target = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState<ShellHost | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!target.current) return;
    let current: ShellHost;
    try {
      current = createShellHost({
        context: services.runtime.host, target: target.current,
        providerReady: (pluginId, generation) => services.runtime.webPlugins.diagnosticSnapshot()
          .some((item) => item.id === pluginId && item.generation === generation && item.state === 'loaded'),
      });
      setShell(current);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '平台外壳宿主无法启动');
      return;
    }
    return () => { void current.dispose(); };
  }, [services]);
  useEffect(() => {
    const events = services.runtime.host.extensions;
    const release = events?.subscribeEvent('host.platform.recovery.requested', () => services.runtime.recovery.open());
    return () => { void release?.(); };
  }, [services]);
  return <MessageProvider controller={services.messages}><div className="relative h-dvh min-h-0 w-full overflow-hidden bg-[#F5F6FB]">
    <div ref={target} className="relative h-full min-h-0 w-full" />
    {shell && <PlatformRecovery services={services} shell={shell} />}
    {error && <p role="alert" className="fixed left-6 top-6 z-[700] rounded-xl border border-[#F1D8B5] bg-white p-5 text-sm text-[#A65D0D]">{error}</p>}
  </div></MessageProvider>;
}
