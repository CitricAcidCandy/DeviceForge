import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HostContext, LocalPointContribution, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import type { MountPool } from './mount-pool.ts';
import type { ShellState } from './controller.ts';

export function viewReference(value: unknown): WorkspaceViewRef | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    'pluginId' in value && typeof value.pluginId === 'string' && value.pluginId.length > 0 &&
    'viewId' in value && typeof value.viewId === 'string' && value.viewId.length > 0
    ? { pluginId: value.pluginId, viewId: value.viewId } : null;
}
export function ChromeAddons({ context, region, pool, state }: {
  readonly context: HostContext; readonly region: 'header' | 'sidebar' | 'footer';
  readonly pool: MountPool; readonly state: ShellState;
}) {
  const points = context.extensions?.points;
  const point = { id: `deviceforge_shell.${region}`, version: '1' };
  useSyncExternalStore(points?.subscribe ?? (() => () => {}), () => points?.catalog(), () => points?.catalog());
  const entries = points?.list(point).filter((entry) => entry.state === 'active' && entry.mode === 'append') ?? [];
  return <>{entries.map((entry) => <ChromeAddon key={`${entry.provider.pluginId}:${entry.id}:${entry.provider.generation}`}
    context={context} entry={entry} region={region} pool={pool} state={state} />)}</>;
}
function ChromeAddon({ context, entry, region, pool, state }: {
  readonly context: HostContext; readonly entry: LocalPointContribution;
  readonly region: string; readonly pool: MountPool; readonly state: ShellState;
}) {
  const [id, setId] = useState<string | null>(null);
  const renderId = useId();
  // 准备中的候选与现用外壳可同时消费同一贡献，实例必须归各自渲染位置所有。
  const instanceId = `deviceforge_shell.addon.${renderId.replace(/[^a-z0-9._-]/giu, '-').toLowerCase()}`;
  const [error, setError] = useState<string | null>(null);
  const target = useRef<HTMLDivElement>(null);
  useSyncExternalStore(pool.subscribe, pool.revision, pool.revision);
  const snapshot = useSyncExternalStore(context.ui?.subscribe ?? (() => () => {}),
    context.ui?.snapshot ?? (() => state.model), context.ui?.snapshot ?? (() => state.model));
  const instance = snapshot.instances.find((item) => item.instanceId === id);
  const provider = viewReference(entry.payload) ?? viewReference(entry.data);
  const providerId = provider?.pluginId, viewId = provider?.viewId;
  useEffect(() => {
    const ui = context.ui;
    if (!ui || !providerId || !viewId) { setError('扩展视图引用无效'); return; }
    try {
      ui.open({ instanceId, workspaceId: `deviceforge_shell.chrome.${region}`,
        provider: { pluginId: providerId, viewId }, visible: true });
      setId(instanceId); setError(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '扩展暂时无法显示'); }
    return () => { if (!context.signal.aborted) ui.close(instanceId); };
  }, [context, entry.id, entry.provider.pluginId, entry.provider.generation, providerId, viewId, region, instanceId]);
  useLayoutEffect(() => {
    if (!id || !target.current) return;
    try {
      const detach = pool.attach(id, target.current);
      setError(null);
      void pool.prepare(id).catch(() => undefined);
      return () => { void detach(); };
    } catch (failure) { setError(failure instanceof Error ? failure.message : '扩展暂时无法显示'); }
  }, [id, instance?.generation, pool]);
  const status = id ? pool.status(id) : null;
  const message = error ?? status?.error;
  return <div className="min-w-0" aria-label={`扩展来源 ${entry.provider.pluginId}`}>
    {message && <div className="text-xs text-[#A65D0D]" role="status">{message}
      {id && instance?.state === 'ready' && <button type="button" className="ml-2 rounded border border-[#E6EAF3] px-2 py-1"
        onClick={() => {
          setError(null);
          try {
            void pool.retry(id).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : '扩展暂时无法显示'));
          } catch (failure) { setError(failure instanceof Error ? failure.message : '扩展暂时无法显示'); }
        }}>重新打开扩展</button>}
    </div>}
    <div ref={target} hidden={!!message} className={region === 'header'
      ? 'h-8 min-h-0 min-w-0 max-w-64 overflow-auto' : 'min-h-0 min-w-0'} />
  </div>;
}
