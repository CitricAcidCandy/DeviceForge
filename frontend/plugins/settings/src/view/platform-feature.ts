import { useEffect, useRef, useState } from 'react';
import type { HostContext, ServiceRef } from '@deviceforge/plugin-sdk';

let nextFeature = 0;
/** 可选能力按功能作用域等待和撤销，不因连接插件缺失卸载整个设置页。 */
export function usePlatformFeature(context: HostContext, ref: ServiceRef) {
  const identity = useRef(`settings.platform.${++nextFeature}`);
  const [available, setAvailable] = useState<HostContext | null>(null);
  useEffect(() => {
    let mounted = true;
    const stop = context.services?.whenAvailable(identity.current, [ref], (feature) => {
      if (mounted) setAvailable(feature);
      return () => { if (mounted) setAvailable(null); };
    });
    return () => { mounted = false; void stop?.(); };
  }, [context, ref.id, ref.version]);
  return available;
}
