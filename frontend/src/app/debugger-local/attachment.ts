import type { DebugAccess, DebugNodeHandle, Dispose } from '../../plugin-sdk/index.ts';
import { createDebugRegistry, scopedDebugAccess } from '../../plugins/debugger/index.ts';
import type { PluginScope } from '../../plugins/scope.ts';
import type { AttachedDebug } from './types.ts';
import { clearCollectors } from './ui.ts';

export function resetSession(entry: AttachedDebug): void {
  clearCollectors(entry);
  entry.session = new AbortController();
  const events = entry.registry.snapshot().events;
  entry.eventFloor = events.at(-1)?.sequence ?? entry.eventFloor;
  entry.lifecycle.length = 0;
}

export function createAttachment(pluginId: string, generation: string, scope: PluginScope, hostSignal: AbortSignal,
  selected: () => boolean, remove: (entry: AttachedDebug) => void,
  closeSession?: (sessionId: string) => Promise<void>): AttachedDebug {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([scope.context.signal, hostSignal, lifetime.signal]);
  const quietTrack = (release: Dispose): Dispose => scope.track(async () => {
    try { await release(); } catch { /* 调试释放失败保留在登记表，不传播到业务清理。 */ }
  });
  const registry = createDebugRegistry({ pluginId, generation: Number(generation) }, signal, quietTrack);
  const scoped = scopedDebugAccess(registry.debug, signal, quietTrack);
  const sessions = new Map<string, Dispose>();
  const entry: AttachedDebug = {
    pluginId, generation, scope, lifetime, registry, access: {
      ...(closeSession ? { registerSession(sessionId: string): Dispose {
        if (signal.aborted || !sessionId || sessionId.length > 128 || /\s/.test(sessionId))
          throw new Error('调试会话标识无效或所属作用域已关闭');
        const existing = sessions.get(sessionId);
        if (existing) return existing;
        if (sessions.size >= 64) throw new Error('当前插件最多登记64项调试会话');
        let released = false;
        const release = quietTrack(async () => {
          if (released) return;
          released = true; sessions.delete(sessionId);
          try { await closeSession(sessionId); } catch (error) { recordFailure(); throw error; }
        });
        sessions.set(sessionId, release);
        return release;
      } } : {}),
      registerNode(definition) {
        try {
          const handle = scoped.registerNode(definition);
          return { id: handle.id, generation: handle.generation,
            update(update) { try { handle.update(update); } catch { recordFailure(); } },
            dispose() { try { return handle.dispose(); } catch { recordFailure(); } },
          };
        } catch {
          recordFailure();
          const handle: DebugNodeHandle = { id: 'unregistered', generation: 0, update: () => {}, dispose: () => {} };
          return handle;
        }
      },
      emit(event) {
        if (!selected() || signal.aborted) return;
        try { scoped.emit(event); } catch { recordFailure(); }
      },
      registerResource(definition, release) {
        let task: Promise<void> | undefined;
        const once = () => (task ??= Promise.resolve().then(release));
        // 元数据观测可以降级，真实业务资源的释放失败仍须进入原插件清理诊断。
        const owned = scope.track(once);
        try { return scoped.registerResource(definition, once); }
        catch { recordFailure(); return owned; }
      },
    }, lifecycle: [], collectors: new Map(), session: new AbortController(), eventFloor: 0, registrationFailures: 0,
  };
  function recordFailure() { entry.registrationFailures = Math.min(Number.MAX_SAFE_INTEGER, entry.registrationFailures + 1); }
  const close = () => {
    signal.removeEventListener('abort', close);
    clearCollectors(entry);
    entry.lifecycle.length = 0;
    remove(entry);
  };
  signal.addEventListener('abort', close, { once: true });
  quietTrack(() => { lifetime.abort(); close(); });
  if (signal.aborted) close();
  return entry;
}
