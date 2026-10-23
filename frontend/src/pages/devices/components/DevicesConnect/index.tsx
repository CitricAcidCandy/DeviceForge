import { useEffect, useState } from 'react';
import { Button } from '../../../../components/Button/index.tsx';
import { Label } from '../../../../components/Label/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/Select/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/Dialog/index.tsx';
import type { DeviceProviderInfo } from '../../../../plugin-sdk/index.ts';
import { EmptyState, Field } from '../../../../components/index.ts';
import { errorLogId, isCancelledAction, useAction, useSnapshot } from '../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import {
  capabilityGate,
  decodeDeviceBusinessResult,
  executeDeviceTask,
} from '../../../../features/device-apps/index.ts';

const providerKey = (provider: DeviceProviderInfo) =>
  JSON.stringify([provider.id, provider.generation]);
interface DisconnectTarget {
  readonly provider: DeviceProviderInfo;
  readonly address: string;
}

export function DevicesConnect({
  services,
  initialProvider = null,
}: {
  services: ProductServices;
  initialProvider?: DeviceProviderInfo | null;
}) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const action = useAction();
  const [selection, setSelection] = useState(initialProvider ? providerKey(initialProvider) : '');
  const [address, setAddress] = useState('');
  const [confirmation, setConfirmation] = useState<DisconnectTarget | null>(null);
  const provider = snapshot.providers.find((item) => providerKey(item) === selection) ?? null;
  const key = provider ? providerKey(provider) : '';
  const operations = catalog.pending ? [] : (catalog.result?.data ?? []);
  const connect = capabilityGate(snapshot, operations, 'connect', provider);
  const disconnect = capabilityGate(snapshot, operations, 'disconnect', provider);
  const confirmationGate = confirmation
    ? capabilityGate(snapshot, operations, 'disconnect', confirmation.provider)
    : null;
  useEffect(() => {
    action.cancel();
    setConfirmation(null);
  }, [key, action.cancel]);
  const run = (id: 'connect' | 'disconnect', target: DeviceProviderInfo, targetAddress: string) => {
    const latestCatalog = services.runtime.operations.snapshot();
    const gate = capabilityGate(
      services.runtime.devices.snapshot(),
      latestCatalog.pending ? [] : (latestCatalog.result?.data ?? []),
      id,
      target,
    );
    if (!gate.capability) {
      services.messages.warning(id === 'connect' ? '连接入口暂不可用' : '断开入口暂不可用', {
        description: gate.reason ?? '提供者能力已变化，请重新读取目录。',
      });
      return;
    }
    void action.run(
      async (signal) => {
        const response = await executeDeviceTask(
          services,
          id,
          {
            providerId: target.id,
            generation: target.generation,
            deviceId: null,
            capability: gate.capability?.id ?? id,
            version: 1,
            input: { address: targetAddress },
          },
          signal,
          decodeDeviceBusinessResult,
        );
        let discovered;
        try {
          discovered = await services.runtime.devices.refreshProvider(
            target.id,
            target.generation,
            signal,
          );
        } catch (error) {
          if (signal.aborted || isCancelledAction(error)) throw error;
          const message = error instanceof Error ? error.message : '设备发现未完成';
          const discoveryLogId = errorLogId(error);
          services.messages.warning(
            id === 'connect' ? '连接已完成，设备目录未更新' : '断开已完成，设备目录未更新',
            {
              description: `${target.id}：${message}；请重新发现后查看最新状态。`,
              logId: discoveryLogId,
              details: [
                { label: '设备发现', message, logId: discoveryLogId },
                ...(response.logId
                  ? [
                      {
                        label: '设备任务',
                        message: id === 'connect' ? '连接已完成' : '断开已完成',
                        logId: response.logId,
                      },
                    ]
                  : []),
              ],
            },
          );
          return { data: response, logId: discoveryLogId };
        }
        if (!signal.aborted)
          services.messages.success(id === 'connect' ? '设备连接已完成' : '设备断开已完成', {
            description: `已重新发现 ${discovered.data.devices.length} 台设备`,
            logId: discovered.logId,
          });
        return { ...response, logId: discovered.logId ?? response.logId };
      },
      { success: null, pending: id === 'connect' ? '正在连接设备' : '正在断开设备' },
    );
  };
  return (
    <div className="workspace-section" data-product-section="devices-connect">
      <h2>连接设备提供者</h2>
      <p className="muted">
        选择提供者并填写连接地址，任务完成后自动重新发现设备。地址格式由提供者校验。
      </p>
      {snapshot.providers.length ? (
        <>
          <fieldset disabled={action.pending} className="form-grid">
            <div className="form-field">
              <Label>连接提供者</Label>
              <Select value={provider ? selection : ''} onValueChange={setSelection}>
                <SelectTrigger aria-label="连接提供者">
                  <SelectValue placeholder="选择当前运行提供者" />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.providers.map((item) => (
                    <SelectItem value={providerKey(item)} key={providerKey(item)}>
                      {item.id} · {item.definition.platform} · {item.generation}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field
              label="设备连接地址"
              value={address}
              onChange={setAddress}
              placeholder="填写所选提供者支持的真实地址"
            />
          </fieldset>
          <div className="page-actions">
            <Button
              disabled={!provider || !address.trim() || !connect.capability || action.pending}
              title={connect.reason ?? undefined}
              onClick={() => {
                if (provider) run('connect', provider, address.trim());
              }}
            >
              连接地址
            </Button>
            <Button
              variant="outline"
              disabled={!provider || !address.trim() || !disconnect.capability || action.pending}
              title={disconnect.reason ?? undefined}
              onClick={() => {
                if (provider) setConfirmation({ provider, address: address.trim() });
              }}
            >
              断开地址
            </Button>
          </div>
          {provider && connect.reason && (
            <p className="capability-notice">连接：{connect.reason}</p>
          )}
          {provider && disconnect.reason && (
            <p className="capability-notice">断开：{disconnect.reason}</p>
          )}
        </>
      ) : (
        <EmptyState
          title="没有运行中的设备提供者"
          description="先加载支持设备能力的服务器插件并刷新目录。"
        />
      )}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>断开设备地址？</DialogTitle>
            <DialogDescription>
              提供者 {confirmation?.provider.id} / {confirmation?.provider.generation}，地址{' '}
              {confirmation?.address}。该地址的连接会被断开；取消等待不能证明连接仍保持。
            </DialogDescription>
          </DialogHeader>
          {confirmationGate?.reason && (
            <p className="capability-notice">{confirmationGate.reason}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              保持连接
            </Button>
            <Button
              variant="destructive"
              disabled={
                !confirmationGate?.capability ||
                action.pending ||
                (confirmation !== null && providerKey(confirmation.provider) !== key)
              }
              onClick={() => {
                const target = confirmation;
                if (target) {
                  setConfirmation(null);
                  run('disconnect', target.provider, target.address);
                }
              }}
            >
              确认断开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
