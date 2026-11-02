import { hostUi } from '@deviceforge/plugin-sdk';
import type { DeviceProviderInfo, HostContext } from '@deviceforge/plugin-sdk';
import { capabilityGate, decodeDeviceBusinessResult } from '@deviceforge/business-kit/device';
import { ErrorNotice } from '@deviceforge/business-kit/react';
import type { OperationSource } from '@deviceforge/business-kit/platform';
import { ActionStatus } from './action-status.tsx';
import { discoverAfterConnection } from './connection-observation.ts';
import type { DirectoryFeedback } from './directory.ts';
import { useActionScope, useDeviceSnapshot } from './workspace-hooks.ts';
import type { ActionScope } from './workspace-hooks.ts';
import { WorkbenchDialog } from './workbench-dialog.tsx';

const providerKey = (provider: DeviceProviderInfo) => JSON.stringify([provider.id, provider.generation]);
export function DeviceConnections({ context, operations, initialProvider, onRefresh }: {
  readonly context: HostContext; readonly operations: OperationSource;
  readonly initialProvider: DeviceProviderInfo | null; readonly onRefresh: () => void;
}) {
  const scope = useActionScope(context, operations);
  return scope ? <ConnectionForm scope={scope} operations={operations} initialProvider={initialProvider} onRefresh={onRefresh} />
    : <p className="p-4 text-xs text-[#596479]">正在打开连接操作</p>;
}
function ConnectionForm({ scope, operations, initialProvider, onRefresh }: {
  readonly scope: ActionScope; readonly operations: OperationSource;
  readonly initialProvider: DeviceProviderInfo | null; readonly onRefresh: () => void;
}) {
  const ui = hostUi(), { useEffect, useRef, useState, useSyncExternalStore } = ui.React;
  const { context, model } = scope;
  const snapshot = useDeviceSnapshot(context.devices, context.signal);
  const catalogue = useSyncExternalStore(operations.subscribe, operations.snapshot, operations.snapshot);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [selection, setSelection] = useState(initialProvider ? providerKey(initialProvider) : '');
  const [address, setAddress] = useState('');
  const [confirmation, setConfirmation] = useState<{ readonly provider: DeviceProviderInfo; readonly address: string } | null>(null);
  const [observation, setObservation] = useState<DirectoryFeedback | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [observing, setObserving] = useState(false);
  const observationController = useRef<AbortController | null>(null);
  const invocation = useRef(0);
  const provider = snapshot.providers.find((entry) => providerKey(entry) === selection) ?? null;
  const key = provider ? providerKey(provider) : '';
  const list = catalogue.pending ? [] : catalogue.result?.data ?? [];
  const connect = capabilityGate(snapshot, list, 'connect', provider);
  const disconnect = capabilityGate(snapshot, list, 'disconnect', provider);
  useEffect(() => {
    invocation.current++;
    model.cancel(); observationController.current?.abort(); observationController.current = null;
    setConfirmation(null); setObservation(null); setObserving(false);
  }, [key, model]);
  const observe = async (target: DeviceProviderInfo) => {
    observationController.current?.abort();
    const controller = new AbortController(); observationController.current = controller;
    setObserving(true);
    try {
      const result = await discoverAfterConnection(context, target, controller.signal);
      if (!context.signal.aborted && observationController.current === controller) setObservation(result);
    } catch (error) {
      if (!context.signal.aborted && observationController.current === controller) setFormError(error);
    } finally {
      if (!context.signal.aborted && observationController.current === controller) {
        observationController.current = null; setObserving(false);
      }
    }
  };
  const run = async (id: 'connect' | 'disconnect', target: DeviceProviderInfo, targetAddress: string) => {
    const serial = ++invocation.current;
    const source = operations.snapshot(), latest = context.devices?.snapshot();
    if (!latest) return;
    const gate = capabilityGate(latest, source.pending ? [] : source.result?.data ?? [], id, target);
    if (!gate.capability) return;
    setObservation(null); setFormError(null);
    let result;
    try { result = await model.run({ provider: target, capability: gate.capability, reference: null, input: { address: targetAddress } }); }
    catch (error) { if (!context.signal.aborted) setFormError(error); return; }
    if (context.signal.aborted || serial !== invocation.current || result.phase !== 'succeeded') return;
    try { decodeDeviceBusinessResult(result.result, result.logId); }
    catch {
      setObservation({ outcome: 'failed', message: '任务已返回，但业务结果结构未确认；未自动重新发现设备', logId: result.logId });
      return;
    }
    await observe(target);
  };
  const busy = state.pending || observing;
  return <section data-product-section="devices-connect" className="space-y-4 p-5 text-xs text-[#222631]">
    <div><h3 className="text-sm font-semibold">连接设备提供者</h3><p className="mt-1 leading-6 text-[#596479]">地址格式由提供者校验。任务确认完成后重新发现；停止等待不代表后台取消。</p></div>
    <ErrorNotice error={catalogue.error} />
    <ErrorNotice error={formError} />
    <button type="button" disabled={catalogue.pending || busy} onClick={onRefresh} className="text-[#6C4CF5] disabled:opacity-50">{catalogue.pending ? '正在读取能力目录' : '刷新能力目录'}</button>
    {snapshot.providers.length ? <>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <label className="grid min-w-0 gap-2">连接提供者<select aria-label="连接提供者" value={provider ? selection : ''} onChange={(event) => setSelection(event.target.value)} className="min-w-0 w-full rounded-md border border-[#E6EAF3] bg-white px-3 py-2">
          <option value="">选择当前运行提供者</option>
          {snapshot.providers.map((entry) => <option key={providerKey(entry)} value={providerKey(entry)}>{entry.id} · {entry.definition.platform} · {entry.generation}</option>)}
        </select></label>
        <label className="grid gap-2">设备连接地址<input aria-label="设备连接地址" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="填写所选提供者支持的真实地址" className="min-w-0 w-full rounded-md border border-[#E6EAF3] bg-white px-3 py-2" /></label>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <ui.Button size="sm" disabled={!provider || !address.trim() || !connect.capability || busy} title={connect.reason ?? undefined} onClick={() => { if (provider) void run('connect', provider, address.trim()); }}>{state.phase === 'unknown' ? '明确重新连接' : '连接地址'}</ui.Button>
        <ui.Button size="sm" variant="outline" disabled={!provider || !address.trim() || !disconnect.capability || busy} title={disconnect.reason ?? undefined} onClick={() => { if (provider) setConfirmation({ provider, address: address.trim() }); }}>断开地址</ui.Button>
        <ui.Button size="sm" variant="ghost" disabled={!provider || busy} onClick={() => { if (provider) void observe(provider); }}>重新发现并更新目录</ui.Button>
      </div>
      {provider && connect.reason && <p className="leading-6 text-[#596479]">连接：{connect.reason}</p>}
      {provider && disconnect.reason && <p className="leading-6 text-[#596479]">断开：{disconnect.reason}</p>}
    </> : <p className="rounded-lg border border-dashed border-[#E6EAF3] p-4 leading-6 text-[#596479]">没有运行中的设备提供者，请先在市场启用并刷新目录。</p>}
    {state.phase === 'unknown' && <p className="text-[#9A5A11]">先查询任务并核对实际连接状态，再明确决定是否重新提交。</p>}
    {observing && <p role="status">{state.phase === 'succeeded' ? '任务已完成，正在重新发现并更新目录' : '正在重新发现并更新目录'}</p>}
    {observation && <div role="status" className="rounded-lg border border-[#E6EAF3] p-3 leading-6 text-[#596479]"><p>{observation.message}</p>{observation.logId && <p className="break-all font-mono text-[10px]">目录日志 ID：{observation.logId}</p>}</div>}
    <ActionStatus model={model} />
    <WorkbenchDialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }} title="断开设备地址？" description="该地址的连接会被断开；停止等待不会回滚已执行的断开。">
      <div className="space-y-4 p-5"><p className="break-all text-xs leading-6">提供者 {confirmation?.provider.id} / {confirmation?.provider.generation}，地址 {confirmation?.address}</p>
        <div className="flex flex-wrap justify-end gap-2"><ui.Button variant="outline" onClick={() => setConfirmation(null)}>保持连接</ui.Button>
          <ui.Button variant="destructive" disabled={!confirmation || key !== providerKey(confirmation.provider) || !disconnect.capability || busy} onClick={() => {
            const target = confirmation; setConfirmation(null);
            if (target) void run('disconnect', target.provider, target.address);
          }}>确认断开</ui.Button></div>
      </div>
    </WorkbenchDialog>
  </section>;
}
