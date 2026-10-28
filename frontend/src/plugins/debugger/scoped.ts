import type { DebugAccess, DebugNodeHandle } from '../../plugin-sdk/debug.ts';
import type { Dispose } from '../../plugin-sdk/models.ts';
import type { DebugTrack } from './registry.ts';

export function scopedDebugAccess(parent: DebugAccess, signal: AbortSignal, track: DebugTrack): DebugAccess;
export function scopedDebugAccess(parent: DebugAccess | undefined, signal: AbortSignal, track: DebugTrack): DebugAccess | undefined;
export function scopedDebugAccess(parent: DebugAccess | undefined, signal: AbortSignal, track: DebugTrack): DebugAccess | undefined {
  if (!parent) return undefined;
  let closed = false;
  const releases = new Set<Dispose>();
  const nodes = new Map<string, DebugNodeHandle>();
  function current() { if (closed || signal.aborted) throw new Error('调试子作用域已撤销'); }
  function own(dispose: Dispose): Dispose {
    const release = track(dispose);
    const owned: Dispose = () => { releases.delete(owned); return release(); };
    releases.add(owned);
    return owned;
  }
  function close() {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    for (const release of [...releases].reverse()) {
      // 资源失败由父登记表保留；事件回调不能产生未处理的异步拒绝。
      try { void Promise.resolve(release()).catch(() => {}); } catch { /* 父作用域负责汇总释放错误。 */ }
    }
    nodes.clear();
  }
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  track(() => { signal.removeEventListener('abort', close); close(); });
  return Object.freeze<DebugAccess>({
    ...(parent.registerSession ? { registerSession(sessionId: string) {
      current();
      const register = parent.registerSession;
      if (!register) throw new Error('调试会话归属入口已撤销');
      return own(register(sessionId));
    } } : {}),
    registerNode(definition) {
      current();
      const handle = parent.registerNode(definition);
      nodes.set(handle.id, handle);
      let released = false;
      const dispose = own(() => {
        released = true;
        if (nodes.get(handle.id) === handle) nodes.delete(handle.id);
        return handle.dispose();
      });
      return Object.freeze({ id: handle.id, generation: handle.generation,
        update(update: Parameters<DebugNodeHandle['update']>[0]) {
          current();
          if (released) throw new Error('调试子作用域节点已撤销');
          handle.update(update);
        }, dispose });
    },
    emit(event) {
      current();
      if (event.nodeId !== undefined && !nodes.has(event.nodeId)) throw new Error('事件节点不属于当前调试子作用域');
      parent.emit(event);
    },
    registerResource(definition, release) {
      current();
      return own(parent.registerResource(definition, release));
    },
  });
}
