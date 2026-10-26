import { useEffect, useRef } from 'react';
import type { ProductServices } from '../../../../app/product/services.ts';
import { RecoveryPanel, usePluginRecovery } from '../../screen/RecoveryPanel/index.tsx';

const target = { key: 'plugin:mirroring' };
const failures: readonly unknown[] = [];

export function NoDeviceRecovery({ services, active }: {
  readonly services: ProductServices;
  readonly active: boolean;
}) {
  const directoryScope = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    directoryScope.current = controller;
    return () => {
      controller.abort();
      if (directoryScope.current === controller) directoryScope.current = null;
    };
  }, [active, services]);
  const recovery = usePluginRecovery({
    client: services.client, target, active, failures, blocked: false,
    onRecovered: async (signal) => {
      const scope = directoryScope.current;
      if (!scope || scope.signal.aborted || signal.aborted) return;
      // 恢复只刷新观测；离页也撤销后续目录读取，不重放任何设备动作。
      await services.runtime.devices.refreshDirectories(AbortSignal.any([signal, scope.signal]));
    },
  });
  return (
    <div className="w-full max-w-lg px-4 text-left">
      <RecoveryPanel
        state={recovery.state}
        activeSession={false}
        recover={recovery.recover}
        refresh={recovery.refresh}
        cancel={recovery.cancel}
      />
    </div>
  );
}
