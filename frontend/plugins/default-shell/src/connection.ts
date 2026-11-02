import type { HostContext } from '@deviceforge/plugin-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ShellConnection {
  readonly state: 'waiting' | 'connecting' | 'connected' | 'failed';
  readonly text: string;
  readonly logId: string | null;
  readonly error: string | null;
}
const initial: ShellConnection = { state: 'waiting', text: '等待连接', logId: null, error: null };

/** 只读取公开操作目录判断连接，不将插件登记或本地挂载当成服务器在线。 */
export function createShellConnection(context: HostContext) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]);
  const listeners = new Set<() => void>();
  let snapshot: ShellConnection = initial;
  let pending: Promise<void> | null = null;
  const publish = (next: ShellConnection) => {
    if (signal.aborted) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh() {
      if (pending || signal.aborted) return pending ?? Promise.resolve();
      publish({ ...snapshot, state: 'connecting', text: '正在连接', error: null });
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      let stopWaiting = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const cancel = () => reject(new Error('连接查询已取消或超时'));
        requestSignal.addEventListener('abort', cancel, { once: true });
        stopWaiting = () => requestSignal.removeEventListener('abort', cancel);
        if (requestSignal.aborted) cancel();
      });
      const request = Promise.race([
        Promise.resolve().then(() => context.listOperations(requestSignal)), aborted,
      ]).then((result) => {
        publish({ state: 'connected', text: '服务器已连接', logId: result.logId, error: null });
      }, (error: unknown) => {
        publish({
          state: 'failed', text: '服务器连接失败',
          logId: error && typeof error === 'object' && 'logId' in error && typeof error.logId === 'string'
            ? error.logId : null,
          error: error instanceof Error ? error.message : '读取操作目录失败',
        });
      }).finally(stopWaiting);
      pending = request.finally(() => { pending = null; });
      return pending;
    },
    dispose() { lifetime.abort(); listeners.clear(); },
  };
}

/** 每次挂载效果独立创建读取作用域，兼容严格模式的挂载清理重放。 */
export function useShellConnection(context: HostContext) {
  const [snapshot, setSnapshot] = useState(initial);
  const current = useRef<ReturnType<typeof createShellConnection> | null>(null);
  useEffect(() => {
    const connection = createShellConnection(context);
    current.current = connection;
    const unsubscribe = connection.subscribe(() => setSnapshot(connection.snapshot()));
    setSnapshot(connection.snapshot());
    void connection.refresh();
    return () => {
      if (current.current === connection) current.current = null;
      unsubscribe();
      connection.dispose();
    };
  }, [context]);
  const refresh = useCallback(() => current.current?.refresh() ?? Promise.resolve(), []);
  return { snapshot, refresh };
}
