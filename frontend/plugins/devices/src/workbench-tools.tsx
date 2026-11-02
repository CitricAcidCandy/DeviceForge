import { hostUi } from '@deviceforge/plugin-sdk';
import type { DeviceProviderInfo, DeviceRef, HostContext } from '@deviceforge/plugin-sdk';
import { createOperationSource } from '@deviceforge/business-kit/platform';
import type { OperationSource } from '@deviceforge/business-kit/platform';
import { DeviceCapabilities } from './capabilities.tsx';
import { DeviceConnections } from './connections.tsx';

export function WorkbenchTools(props: {
  readonly kind: 'connection' | 'capabilities'; readonly context: HostContext;
  readonly reference: DeviceRef | null; readonly provider: DeviceProviderInfo | null;
  readonly onShowPane?: ((pane: 'params' | 'apps') => void) | undefined;
}) {
  const { useEffect, useState } = hostUi().React;
  const [owned, setOwned] = useState<{ context: HostContext; operations: OperationSource } | null>(null);
  useEffect(() => {
    if (props.context.signal.aborted) return;
    const controller = new AbortController();
    const context = { ...props.context, signal: AbortSignal.any([props.context.signal, controller.signal]) };
    const operations = createOperationSource(context);
    setOwned({ context, operations });
    return () => { controller.abort(); operations.dispose(); };
  }, [props.context]);
  return owned ? <LoadedTools {...props} owned={owned} /> : <p className="p-5 text-xs text-[#596479]">正在读取公开能力目录</p>;
}
function LoadedTools({ kind, owned, provider, reference, onShowPane }: {
  readonly kind: 'connection' | 'capabilities'; readonly owned: { context: HostContext; operations: OperationSource };
  readonly provider: DeviceProviderInfo | null; readonly reference: DeviceRef | null;
  readonly onShowPane?: ((pane: 'params' | 'apps') => void) | undefined;
}) {
  const { useCallback, useEffect, useRef } = hostUi().React;
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(new Error('能力目录读取超时')), 10000);
    void owned.operations.list(AbortSignal.any([owned.context.signal, controller.signal])).catch(() => {
      // 公开目录已保留错误和日志，显示由业务表单负责，不重新派发动作。
    }).finally(() => clearTimeout(timer));
  }, [owned]);
  useEffect(() => { refresh(); return () => { request.current?.abort(); }; }, [refresh]);
  return <div className="@container/device-tools min-h-0 min-w-0">
    {kind === 'connection'
      ? <DeviceConnections context={owned.context} operations={owned.operations} initialProvider={provider} onRefresh={refresh} />
      : <><button type="button" onClick={refresh} className="ml-5 mt-4 text-xs text-[#6C4CF5]">刷新能力目录</button>
        <DeviceCapabilities context={owned.context} operations={owned.operations} reference={reference} onShowPane={onShowPane} /></>}
  </div>;
}
