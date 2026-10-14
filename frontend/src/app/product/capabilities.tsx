import { LoaderCircle } from 'lucide-react';
import { useSnapshot } from './hooks.ts';
import type { ProductServices } from './services.ts';

export function OperationNotice({
  services,
  operation,
}: {
  services: ProductServices;
  operation: string;
}) {
  const catalog = useSnapshot(services.runtime.operations);
  if (catalog.pending)
    return (
      <p className="muted">
        <LoaderCircle className="inline-spinner" />
        正在核对能力
      </p>
    );
  const available = catalog.result?.data.some((item) => item.id === operation) ?? false;
  return available ? null : (
    <p className="capability-notice">
      当前服务器尚未提供此功能。请在插件页安装或加载对应插件，再刷新目录。
    </p>
  );
}

export function useOperationAvailable(services: ProductServices, operation: string): boolean {
  const catalog = useSnapshot(services.runtime.operations);
  return catalog.result?.data.some((item) => item.id === operation) ?? false;
}
