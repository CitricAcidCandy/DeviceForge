import { hostUi } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { createDeviceDirectory } from './directory.ts';
import type { DeviceDirectoryModel, DirectoryState } from './directory.ts';
import { DirectoryPage } from './directory-page.tsx';
import { readDirectoryUi, requestDirectoryNavigation, updateDirectoryUi } from './directory-navigation.ts';

function DirectoryFeedbackView({ model, snapshot }: { readonly model: DeviceDirectoryModel; readonly snapshot: DirectoryState }) {
  const { useState } = hostUi().React;
  const [notice, setNotice] = useState<string | null>(null);
  const feedback = snapshot.feedback;
  if (!feedback && !snapshot.pending && !notice) return null;
  return <div className="shrink-0 space-y-1 border-b border-hairline px-5 py-2 text-xs leading-5">
    {snapshot.pending && <div role="status" className="flex items-center justify-between gap-2 text-body">
      <span>{snapshot.pending}，等待结果</span><button type="button" className="text-primary" onClick={model.cancel}>取消等待</button>
    </div>}
    {feedback && <div role="status" className={feedback.outcome === 'completed' ? 'text-body' : 'text-warning'}>
      <p>{feedback.message}</p>
      {feedback.details?.map((failure) => <p key={failure.provider} className="break-words">{failure.provider}：{failure.message}{failure.logId ? ` · 日志 ID：${failure.logId}` : ''}</p>)}
      {feedback.logId && <button type="button" className="break-all text-left font-mono text-[10px] text-faint" onClick={() => {
        if (globalThis.navigator?.clipboard && feedback.logId)
          void globalThis.navigator.clipboard.writeText(feedback.logId).then(() => setNotice('日志 ID 已复制'), () => setNotice('无法复制，请手动选择日志 ID'));
      }}>日志 ID：{feedback.logId} · 复制</button>}
    </div>}
    {notice && <p role="status" className="text-faint">{notice}</p>}
  </div>;
}

/** 目录由设备插件呈现完整选择页；模型只消费公开设备与操作目录。 */
export function DeviceDirectory({ context, model, onClose, onConnect, instance }: {
  readonly context: HostContext; readonly model: DeviceDirectoryModel;
  readonly onClose?: () => void; readonly onConnect?: () => void; readonly instance?: WorkspaceViewContext;
}) {
  const { useSyncExternalStore } = hostUi().React;
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const instanceId = instance?.snapshot().instanceId;
  const retained = instanceId ? readDirectoryUi(context, instanceId) : { query: '', source: 'all' };
  return <DirectoryPage snapshot={snapshot.devices} pending={snapshot.pending !== null}
    select={model.select} discover={(provider) => { void model.discover(provider); }}
    discoverAll={() => { void model.discoverAll(); }} read={() => { void model.refresh(); }} titleOf={model.titleOf}
    connect={onConnect ?? (() => requestDirectoryNavigation(context, instance, 'connect'))}
    onClose={onClose ?? (() => requestDirectoryNavigation(context, instance, 'close'))}
    feedback={<DirectoryFeedbackView model={model} snapshot={snapshot} />}
    initialQuery={retained.query} initialSource={retained.source}
    onQueryChange={(query) => { if (instanceId) updateDirectoryUi(context, instanceId, { query }); }}
    onSourceChange={(source) => { if (instanceId) updateDirectoryUi(context, instanceId, { source }); }} />;
}

export function mountDirectory(target: HTMLElement, context: HostContext, instance?: WorkspaceViewContext) {
  const model = createDeviceDirectory(context);
  let release: Dispose;
  try { release = hostUi().mountReact(target, <DeviceDirectory context={context} model={model} {...(instance ? { instance } : {})} />); }
  catch (error) { void model.dispose(); throw error; }
  return async () => {
    const failures: unknown[] = [];
    try { await model.dispose(); } catch (error) { failures.push(error); }
    try { await release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, '设备目录回收未确认');
  };
}
