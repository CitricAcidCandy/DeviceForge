import { ApiError } from '../api/index.ts';
import { messageBytes, readRealtimeEnvelope, realtimeFailure } from './envelope.ts';
import type { RealtimeManager, RealtimeNamespace, RealtimeSocket, RealtimeState } from './types.ts';

export interface SharedBudget { bytes: number; requests: number }
export function createChannel(namespace: RealtimeNamespace, options: {
  readonly signal: AbortSignal;
  readonly manager: () => Promise<RealtimeManager>;
  readonly supported: () => Promise<boolean>;
  readonly budget: SharedBudget;
  readonly reconnectMs: number;
}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const listeners = new Set<(state: RealtimeState) => void>();
  const events = new Map<string, Set<(value: unknown) => void>>();
  const cleanup: (() => void)[] = [];
  let socket: RealtimeSocket | null = null;
  let state: RealtimeState = { state: 'unavailable', revision: null, reset: true };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const safe = <T>(listener: (value: T) => void, value: T) => { try { listener(value); } catch { /* 消费者错误只归属自身。 */ } };
  function publish(next: RealtimeState) {
    if (signal.aborted) return;
    state = next;
    for (const listener of [...listeners]) safe(listener, next);
  }
  function arm() {
    if (timer || signal.aborted) return;
    timer = setTimeout(() => {
      timer = null; socket?.disconnect();
      publish({ state: 'unavailable', revision: state.revision, reset: true });
    }, options.reconnectMs);
  }
  function bind(event: string) {
    if (!socket) return;
    cleanup.push(socket.on(event, value => {
      if (signal.aborted) return;
      for (const listener of [...events.get(event) ?? []]) safe(listener, value);
    }));
  }
  const supported = (async () => {
    const available = await options.supported();
    if (signal.aborted || !available) return false;
    const manager = await options.manager();
    signal.throwIfAborted();
    socket = manager.socket(namespace);
    cleanup.push(socket.onConnect(() => {
      if (timer) clearTimeout(timer); timer = null;
      publish({ state: 'ready', revision: null, reset: true });
    }), socket.onDisconnect(() => {
      publish({ state: 'unavailable', revision: state.revision, reset: true }); arm();
    }), socket.onError(() => {
      publish({ state: 'unavailable', revision: state.revision, reset: true }); arm();
    }));
    for (const event of events.keys()) bind(event);
    arm(); socket.connect();
    return true;
  })();
  void supported.catch(() => publish({ state: 'unavailable', revision: null, reset: true }));
  const dispose = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(); if (timer) clearTimeout(timer); timer = null;
    for (const release of cleanup.splice(0)) release();
    socket?.disconnect(); socket = null; listeners.clear(); events.clear();
    options.signal.removeEventListener('abort', dispose);
  };
  options.signal.addEventListener('abort', dispose, { once: true });
  if (options.signal.aborted) dispose();
  return {
    supported,
    connected: () => !signal.aborted && socket?.connected() === true,
    subscribe(listener: (next: RealtimeState) => void) {
      if (signal.aborted) return () => {};
      listeners.add(listener); safe(listener, state);
      return () => { listeners.delete(listener); };
    },
    on(event: string, listener: (value: unknown) => void) {
      if (signal.aborted) return () => {};
      let list = events.get(event);
      if (!list) { list = new Set(); events.set(event, list); bind(event); }
      list.add(listener);
      return () => { list.delete(listener); };
    },
    async request(event: string, value: unknown, caller: AbortSignal, timeoutMs = 5000): Promise<unknown> {
      const current = socket;
      if (signal.aborted || caller.aborted) throw new ApiError('cancelled', 'cancelled', '实时请求等待已结束');
      if (!current?.connected()) throw new ApiError('network', 'realtime_disconnected', '实时连接暂不可用，请核对原操作状态');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
        throw realtimeFailure('realtime_invalid_timeout', '实时请求等待必须在 1 至 10000 毫秒之间');
      const bytes = messageBytes(value);
      if (options.budget.requests >= 8 || options.budget.bytes + bytes > 8 * 1024 * 1024)
        throw realtimeFailure('realtime_capacity', '实时通道待确认消息已满，本次消息未发送');
      options.budget.requests++; options.budget.bytes += bytes;
      try {
        return await new Promise<unknown>((resolve, reject) => {
          let ended = false;
          const waiting = AbortSignal.any([signal, caller]);
          const finish = (error: unknown, result?: unknown) => {
            if (ended) return;
            ended = true; clearTimeout(deadline); waiting.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(result);
          };
          const abort = () => finish(new ApiError('cancelled', 'cancelled', '实时请求等待已结束，已发送动作的结果仍需核对'));
          const deadline = setTimeout(() => finish(new ApiError('network', 'realtime_ack_timeout', '实时回执等待到期，不能据此认定动作未发生')), timeoutMs);
          waiting.addEventListener('abort', abort, { once: true });
          if (waiting.aborted) { abort(); return; }
          try {
            current.send(event, value, reply => {
              try { finish(null, readRealtimeEnvelope(reply)); } catch (error) { finish(error); }
            });
          } catch (error) { finish(error); }
        });
      } finally { options.budget.requests--; options.budget.bytes -= bytes; }
    },
    reconnect() { if (!signal.aborted && socket && !socket.connected()) { arm(); socket.connect(); } },
    dispose,
  };
}
