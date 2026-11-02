import { hostUi } from '@deviceforge/plugin-sdk';
import type { DeviceCapability, DeviceProviderInfo, DeviceRef, HostContext } from '@deviceforge/plugin-sdk';
import type { OperationSource } from '@deviceforge/business-kit/platform';
import { ErrorNotice } from '@deviceforge/business-kit/react';
import { sameDevice } from './contracts.ts';
import { deviceActionReason, parseDeviceInput } from './action-rules.ts';
import { ActionStatus } from './action-status.tsx';
import { useActionScope, useDeviceSnapshot } from './workspace-hooks.ts';
import type { ActionScope } from './workspace-hooks.ts';

export function DeviceCapabilities({ context, operations, reference, onShowPane }: {
  readonly context: HostContext; readonly operations: OperationSource; readonly reference: DeviceRef | null;
  readonly onShowPane?: ((pane: 'params' | 'apps') => void) | undefined;
}) {
  const ui = hostUi(), { useSyncExternalStore } = ui.React;
  const snapshot = useDeviceSnapshot(context.devices, context.signal);
  const catalogue = useSyncExternalStore(operations.subscribe, operations.snapshot, operations.snapshot);
  const device = sameDevice(snapshot.selected?.reference ?? null, reference) ? snapshot.selected : null;
  const provider = snapshot.providers.find((entry) => entry.id === reference?.providerId && entry.generation === reference.generation);
  if (!device || !provider || !sameDevice(snapshot.selection, reference)) return <p role="status" className="p-5 text-xs leading-6 text-[#596479]">当前设备目标已变化，请重新核对工作台设备。</p>;
  const directory = snapshot.directories.find((entry) => entry.provider.id === provider.id && entry.provider.generation === provider.generation);
  const capabilities = provider.definition.capabilities.filter((entry) => entry.scope === 'device');
  const operationsList = catalogue.pending ? [] : catalogue.result?.data ?? [];
  const available = (ids: readonly string[]) => capabilities.some((capability) => ids.includes(capability.id) &&
    deviceActionReason(snapshot, operationsList, { provider, capability, reference, input: {} }) === null);
  return <section data-product-section="device-capabilities" className="space-y-5 p-5 text-xs text-[#222631]">
    <dl className="grid grid-cols-1 gap-3 @sm/device-tools:grid-cols-2">
      {[['设备标识', device.reference.localId], ['提供者', `${provider.id} · ${provider.version}`], ['运行代次', device.reference.generation],
        ['观测时间', directory ? new Date(directory.observedAt).toLocaleString('zh-CN') : '暂无观测'],
        ...(device.rawState ? [['原始状态', device.rawState]] : [])].map(([title, value]) => <div key={title} className="min-w-0"><dt className="text-[#8790A2]">{title}</dt><dd className="mt-1 break-all font-mono text-[11px]">{value}</dd></div>)}
    </dl>
    <ErrorNotice error={catalogue.error} />
    <header className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">设备能力</h3><span className="text-[#8790A2]">{capabilities.length} 项声明</span></header>
    <nav aria-label="公共工具" className="grid grid-cols-1 gap-2 @sm/device-tools:grid-cols-2">
      <a href="#/terminal" className="rounded-lg border border-[#E6EAF3] p-3 text-[#6C4CF5]">终端 · 服务器会话</a>
      <a href="#/performance" className="rounded-lg border border-[#E6EAF3] p-3 text-[#6C4CF5]">性能与调用栈</a>
      {onShowPane && <>
        <button type="button" disabled={!available(['packages', 'app.detail', 'app.install'])} onClick={() => onShowPane('apps')} className="rounded-lg border border-[#E6EAF3] p-3 text-left text-[#6C4CF5] disabled:text-[#8790A2]">应用与安装包</button>
        <button type="button" disabled={!available(['screenshot', 'input'])} onClick={() => onShowPane('params')} className="rounded-lg border border-[#E6EAF3] p-3 text-left text-[#6C4CF5] disabled:text-[#8790A2]">画面与录制</button>
      </>}
    </nav>
    <details className="rounded-lg border border-[#E6EAF3] p-3">
      <summary className="cursor-pointer font-medium">高级能力操作 · 版本、输入模式与原始结果</summary>
      <p className="mt-3 leading-6 text-[#596479]">按提供者声明调用实际能力，业务输入填写 JSON 对象。写入提交后不可回滚，停止等待不等于取消。</p>
      {capabilities.length === 0 && <p className="py-3 text-[#596479]">提供者尚未声明设备能力。</p>}
      <div className="mt-3 space-y-3">{capabilities.map((capability) => <CapabilityAction key={`${capability.id}:${capability.version}:${capability.operation}`} context={context} operations={operations} provider={provider} capability={capability} reference={device.reference} />)}</div>
    </details>
  </section>;
}
function CapabilityAction(props: {
  readonly context: HostContext; readonly operations: OperationSource;
  readonly provider: DeviceProviderInfo; readonly capability: DeviceCapability; readonly reference: DeviceRef;
}) {
  const scope = useActionScope(props.context, props.operations);
  return scope ? <CapabilityForm {...props} scope={scope} /> : null;
}
function CapabilityForm({ scope, operations, provider, capability, reference }: {
  readonly scope: ActionScope; readonly operations: OperationSource;
  readonly provider: DeviceProviderInfo; readonly capability: DeviceCapability; readonly reference: DeviceRef;
}) {
  const ui = hostUi(), { useState, useSyncExternalStore } = ui.React;
  const { context, model } = scope;
  const snapshot = useDeviceSnapshot(context.devices, context.signal);
  const catalogue = useSyncExternalStore(operations.subscribe, operations.snapshot, operations.snapshot);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [input, setInput] = useState('{}'), [error, setError] = useState<unknown>(null);
  const list = catalogue.pending ? [] : catalogue.result?.data ?? [];
  const operation = list.find((entry) => entry.id === capability.operation);
  const reason = deviceActionReason(snapshot, list, { provider, capability, reference, input: {} });
  const run = async () => {
    setError(null);
    try { await model.run({ provider, capability, reference, input: parseDeviceInput(input) }); }
    catch (failure) { if (!context.signal.aborted) setError(failure); }
  };
  return <details className="rounded-lg border border-[#E6EAF3] p-3">
    <summary className="cursor-pointer"><span className="font-medium">{operation?.title ?? capability.id}</span><span className="ml-2 break-all font-mono text-[10px] text-[#8790A2]">{capability.id}@{capability.version} · {capability.access === 'read' ? '读取' : '写入'}</span></summary>
    <div className="mt-3 space-y-3"><p className="break-all font-mono text-[10px] text-[#8790A2]">{capability.operation}</p>
      {reason && <p className="leading-6 text-[#9A5A11]">{reason}</p>}
      <label className="grid gap-2">业务输入<textarea aria-label={`${capability.id}@${capability.version} 业务输入`} value={input} onChange={(event) => setInput(event.target.value)} disabled={state.pending} rows={4} spellCheck={false} className="w-full min-w-0 resize-y rounded-md border border-[#E6EAF3] bg-[#FAFBFE] p-3 font-mono text-xs disabled:opacity-60" /></label>
      <details><summary className="cursor-pointer text-[#596479]">查看服务器输入模式</summary><ui.JsonResult value={operation?.input_schema} /></details>
      <ui.Button size="sm" variant={capability.access === 'write' ? 'outline' : 'secondary'} disabled={reason !== null || state.pending} onClick={() => { void run(); }} title={capability.access === 'write' ? '停止等待不会回滚已执行的写入' : undefined}>
        {state.phase === 'unknown' ? '明确重新提交' : capability.access === 'write' ? '提交写入任务' : '执行读取任务'}
      </ui.Button>
      <ErrorNotice error={error} /><ActionStatus model={model} />
    </div>
  </details>;
}
