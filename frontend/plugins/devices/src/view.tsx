import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext } from '@deviceforge/plugin-sdk';
import { createDeviceDirectory } from './directory.ts';
import type { DeviceDirectoryModel } from './directory.ts';
import { deviceIdentity, sameDevice } from './model.ts';

const states = { online: '在线', offline: '离线', unauthorized: '未授权', unknown: '状态未知' };
export function DeviceDirectory({ context, model }: {
  readonly context: HostContext; readonly model: DeviceDirectoryModel;
}) {
  const ui = hostUi();
  const { useState, useSyncExternalStore } = ui.React;
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = snapshot.devices.selected;
  return <section className="flex min-h-full flex-col gap-4 bg-white p-4 text-[#222631]" aria-label="设备目录">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-sm font-semibold">选择工作区设备</h2>
        <p className="mt-1 text-xs leading-5 text-[#596479]">所有设备视图共享完整目标引用，不会自动启动投屏、采集或写入。</p></div>
      <ui.Button variant="outline" size="sm" disabled={snapshot.pending !== null} onClick={() => { void model.refresh(); }}>刷新目录</ui.Button>
    </header>
    {snapshot.pending && <div role="status" className="flex items-center justify-between rounded-lg bg-[#F5F6FB] px-3 py-2 text-xs">
      <span>{snapshot.pending}，等待结果</span><button type="button" className="text-[#6C4CF5]" onClick={model.cancel}>取消等待</button>
    </div>}
    {snapshot.feedback && <div role="status" className={`rounded-lg border p-3 text-xs leading-5 ${snapshot.feedback.outcome === 'failed' ? 'border-[#E8CDAA] bg-[#FFF8EE] text-[#9A5A11]' : 'border-[#E6EAF3] bg-[#F5F6FB] text-[#596479]'}`}>
      <p>{snapshot.feedback.message}</p>
      {snapshot.feedback.logId && <button type="button" className="mt-1 break-all text-left font-mono text-[10px]" onClick={() => {
        const value = snapshot.feedback?.logId;
        if (value && globalThis.navigator?.clipboard)
          void globalThis.navigator.clipboard.writeText(value).then(() => setNotice('日志 ID 已复制'), () => setNotice('无法复制，请手动选择日志 ID'));
      }}>日志 ID：{snapshot.feedback.logId} · 复制</button>}
    </div>}
    {snapshot.devices.providers.length === 0 && <div className="rounded-xl border border-dashed border-[#E6EAF3] px-4 py-8 text-center">
      <p className="text-sm font-semibold">还没有可用的设备提供者</p><p className="mt-2 text-xs leading-6 text-[#596479]">在市场中启用提供者，再刷新目录。设备平台只用于展示，不决定可用能力。</p>
      <a href="#/marketplace" className="mt-3 inline-block text-xs text-[#6C4CF5]">打开市场</a>
    </div>}
    <div className="space-y-3" role="radiogroup" aria-label="工作区设备">
      {snapshot.devices.providers.map((provider) => {
        const directory = snapshot.devices.directories.find((entry) => entry.provider.id === provider.id && entry.provider.generation === provider.generation);
        return <section key={`${provider.id}:${provider.generation}`} className="overflow-hidden rounded-xl border border-[#E6EAF3]">
          <header className="flex items-center gap-2 bg-[#FAFBFE] px-3 py-2">
            <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{provider.definition.platform}</p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-[#596479]">{provider.id}</p></div>
            <button type="button" disabled={snapshot.pending !== null} className="shrink-0 rounded-md border border-[#E6EAF3] bg-white px-2.5 py-1.5 text-xs text-[#6C4CF5] disabled:opacity-50" onClick={() => { void model.discover(provider); }}>发现设备</button>
          </header>
          {directory?.devices.length ? directory.devices.map((device) => <label key={deviceIdentity(device.reference)} className="flex cursor-pointer items-start gap-3 border-t border-[#E6EAF3] px-3 py-3">
            <input type="radio" name="device-workspace-target" aria-label={`${device.model ?? device.reference.localId}，${states[device.state]}`} className="mt-1 accent-[#6C4CF5]" checked={sameDevice(snapshot.devices.selection, device.reference)} onChange={() => model.select(device.reference)} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{device.model ?? device.reference.localId}</span>
              <span className="mt-1 block break-all font-mono text-[10px] text-[#596479]">{device.reference.localId}</span>
              <span className="mt-1 block text-[10px] text-[#596479]">{states[device.state]} · {device.capabilities.filter((capability) => capability.available).length} 项可用能力</span></span>
          </label>) : <p className="border-t border-[#E6EAF3] px-3 py-4 text-xs leading-5 text-[#596479]">{directory ? '该提供者暂未发现设备，可显式重新发现。' : '尚无目录观测。刷新只读取目录，发现按钮才触发发现。'}</p>}
          {directory && <p className="border-t border-[#E6EAF3] px-3 py-2 text-[10px] text-[#596479]">最后观测：{new Date(directory.observedAt).toLocaleString('zh-CN')}</p>}
        </section>;
      })}
    </div>
    {snapshot.devices.selection && <button type="button" className="self-start text-xs text-[#596479]" onClick={() => model.select(null)}>取消选择设备</button>}
    {selected && <details className="rounded-lg border border-[#E6EAF3] p-3 text-xs">
      <summary className="cursor-pointer font-medium">所选设备能力与完整引用</summary>
      <dl className="mt-3 space-y-1 break-all font-mono text-[10px] text-[#596479]">
        <div><dt className="inline">提供者：</dt><dd className="inline">{selected.reference.providerId}</dd></div>
        <div><dt className="inline">代次：</dt><dd className="inline">{selected.reference.generation}</dd></div>
        <div><dt className="inline">设备：</dt><dd className="inline">{selected.reference.localId}</dd></div>
      </dl>
      <ul className="mt-3 space-y-2">{selected.capabilities.map((capability) => <li key={`${capability.id}:${capability.version}`} className="flex gap-2">
        <span className="min-w-0 flex-1 break-all">{capability.id}@{capability.version}</span>
        <span className="text-[#596479]">{capability.available ? '可用' : capability.reason ?? '不可用'}</span>
      </li>)}</ul>
    </details>}
    {notice && <p role="status" className="text-xs leading-5 text-[#596479]">{notice}</p>}
    <p className="mt-auto text-[10px] leading-5 text-[#596479]">已启用插件提供的设备功能会自动显示。设备写入、投屏及采集仍由对应功能显式发起。</p>
  </section>;
}
export function mountDirectory(target: HTMLElement, context: HostContext) {
  const model = createDeviceDirectory(context);
  const release = hostUi().mountReact(target, <DeviceDirectory context={context} model={model} />);
  return () => { release(); void model.dispose(); };
}
