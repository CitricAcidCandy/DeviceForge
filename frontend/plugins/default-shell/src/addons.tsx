import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HostContext, LocalPointContribution, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import type { MountPool } from './mount-pool.ts';
import type { ShellState } from './controller.ts';
import { identity } from './controller.ts';

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
  const [error, setError] = useState<string | null>(null);
  const target = useRef<HTMLDivElement>(null);
  useSyncExternalStore(pool.subscribe, pool.revision, pool.revision);
  const generation = state.model.instances.find((instance) => instance.instanceId === id)?.generation;
  useEffect(() => {
    const ui = context.ui;
    const provider = viewReference(entry.payload) ?? viewReference(entry.data);
    if (!ui || !provider) { setError('扩展视图引用无效'); return; }
    const instanceId = `deviceforge_shell.addon.${identity(`${region}:${entry.provider.pluginId}:${entry.id}:${entry.provider.generation}`)}`;
    try {
      ui.open({ instanceId, workspaceId: `deviceforge_shell.chrome.${region}`, provider, visible: true });
      setId(instanceId); setError(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '扩展暂时无法显示'); }
    return () => { if (!context.signal.aborted) ui.close(instanceId); };
  }, [context, entry, region]);
  useLayoutEffect(() => {
    if (!id || !target.current) return;
    try {
      const detach = pool.attach(id, target.current);
      void pool.prepare(id).catch(() => undefined);
      return () => { void detach(); };
    } catch (failure) { setError(failure instanceof Error ? failure.message : '扩展暂时无法显示'); }
  }, [id, generation, pool]);
  return <div className="min-w-0" aria-label={`扩展来源 ${entry.provider.pluginId}`}>
    {error ? <span className="text-xs text-[#A65D0D]">{error}</span> : <div ref={target} className={region === 'sidebar' ? 'min-h-0 min-w-0' : 'h-8 min-h-0 min-w-0 max-w-64 overflow-auto'} />}
  </div>;
}
