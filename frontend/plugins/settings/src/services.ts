import type { Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { createSettings } from './model/index.ts';

export interface SettingsServices {
  readonly context: HostContext;
  readonly settings: ReturnType<typeof createSettings>;
  readonly sectionsId: string;
  readonly workspaceId: string;
  readonly operations: ReturnType<typeof createOperations>;
}
function createOperations(context: HostContext) {
  let state: readonly string[] = [];
  const listeners = new Set<() => void>();
  let controller: AbortController | null = null;
  let stop: Dispose | null = null;
  function update(next: readonly string[]) {
    if (state.length === next.length && state.every((item, index) => item === next[index])) return;
    state = next;
    for (const listener of listeners) listener();
  }
  function start() {
    if (controller || context.signal.aborted) return;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.signal]);
    let revision = 0;
    stop = context.subscribeOperations((entries) => { revision++; if (!signal.aborted) update(entries.map((entry) => entry.id)); });
    const expected = revision;
    void context.listOperations(signal).then((result) => {
      if (!signal.aborted && revision === expected) update(result.data.map((entry) => entry.id));
    }).catch(() => { if (!signal.aborted && revision === expected) update([]); });
  }
  function dispose() { controller?.abort(); controller = null; void stop?.(); stop = null; listeners.clear(); }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); start(); return () => { listeners.delete(listener); }; },
    dispose,
  };
}
export function createSettingsServices(context: HostContext, sectionsId: string, workspaceId: string): SettingsServices {
  const settings = createSettings(context, { signal: context.signal });
  const operations = createOperations(context);
  context.onDispose(settings.dispose);
  context.onDispose(operations.dispose);
  return { context, settings, sectionsId, workspaceId, operations };
}
