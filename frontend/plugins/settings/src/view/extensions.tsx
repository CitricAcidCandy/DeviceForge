import { useEffect, useRef, useState } from 'react';
import type { Dispose, HostContext, LocalPointContribution, WorkspaceViewRef } from '@deviceforge/plugin-sdk';

function viewRef(value: unknown): value is WorkspaceViewRef {
  return !!value && typeof value === 'object' &&
    'pluginId' in value && typeof value.pluginId === 'string' &&
    'viewId' in value && typeof value.viewId === 'string';
}
let nextExtension = 0;
function SettingsExtension({ context, entry, workspaceId }: { context: HostContext; entry: LocalPointContribution; workspaceId: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const data = entry.data;
  const ref = data && typeof data === 'object' && !Array.isArray(data) && viewRef(data.view) ? data.view : null;
  const title = data && typeof data === 'object' && !Array.isArray(data) && typeof data.title === 'string' ? data.title : entry.id;
  useEffect(() => {
    const ui = context.ui, root = target.current;
    if (!ui?.mount || !root || !ref) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.signal]);
    const id = `${workspaceId}.extension.${++nextExtension}`;
    let release: Dispose | null = null;
    setError(null);
    try {
      ui.open({ instanceId: id, workspaceId, provider: ref }, signal);
      void ui.mount(id, root, signal).then((dispose) => {
        if (signal.aborted) void Promise.resolve(dispose()).catch(() => undefined);
        else release = dispose;
      }).catch((reason: unknown) => {
        if (!signal.aborted) setError(reason instanceof Error ? reason.message : '扩展设置挂载失败');
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '扩展设置实例创建失败');
    }
    return () => {
      controller.abort();
      if (release) void Promise.resolve(release()).catch(() => undefined);
      if (!context.signal.aborted) ui.close(id);
    };
  }, [context, entry.id, entry.provider.generation, ref?.pluginId, ref?.viewId, workspaceId, attempt]);
  return <section className="mt-7 border-t border-hairline pt-5" aria-label={title}>
    <h3 className="text-sm font-medium text-ink">{title}</h3>
    <p className="mt-1 text-xs text-muted-foreground">提供者：{entry.provider.pluginId}</p>
    {error && <div className="mt-3 text-sm text-destructive" role="alert">
      <p>{error}</p>
      <button type="button" className="mt-2 rounded border border-hairline px-3 py-1 text-body" onClick={() => setAttempt((value) => value + 1)}>重新挂载设置扩展</button>
    </div>}
    <div ref={target} className="mt-4 min-w-0" />
  </section>;
}
export function SettingsExtensions({ context, pointId, workspaceId }: { context: HostContext; pointId: string; workspaceId: string }) {
  const points = context.extensions?.points;
  const [entries, setEntries] = useState<readonly LocalPointContribution[]>(() => points?.list({ id: pointId, version: '1' }) ?? []);
  useEffect(() => {
    setEntries(points?.list({ id: pointId, version: '1' }) ?? []);
    const stop = points?.subscribe(() => setEntries(points.list({ id: pointId, version: '1' })));
    return () => { void stop?.(); };
  }, [points, pointId]);
  const active = entries.filter((entry) => entry.state === 'active' && entry.mode === 'append');
  return <div>
    {!active.length && <p className="mt-7 text-[13px] leading-6 text-muted-foreground">当前没有插件提供设置项。</p>}
    {active.map((entry) => <SettingsExtension key={entry.id} context={context} entry={entry} workspaceId={workspaceId} />)}
  </div>;
}
