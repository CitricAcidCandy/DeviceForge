import { ApiError } from '../api/index.ts';
import type { RealtimeManagerFactory, RealtimeSocket } from './types.ts';

/** 客户端库仅在第一个消费者需要连接时加载，不进入工作台启动依赖。 */
export const createSocketManager: RealtimeManagerFactory = async (options) => {
  const { Manager } = await import('socket.io-client');
  options.signal.throwIfAborted();
  const manager = new Manager(options.baseUrl, {
    path: '/api/v2/realtime/socket.io', transports: ['websocket'], autoConnect: false,
    reconnection: true, reconnectionAttempts: 12, reconnectionDelay: 500,
    reconnectionDelayMax: 5000, randomizationFactor: 0.2, timeout: 5000,
  });
  const sockets = new Set<RealtimeSocket>();
  return {
    socket(namespace) {
      const socket = manager.socket(namespace, {
        auth(callback) {
          const signal = AbortSignal.any([options.signal, AbortSignal.timeout(5000)]);
          let closed = false;
          const finish = (token: string | null) => {
            if (closed) return;
            closed = true; signal.removeEventListener('abort', abort);
            callback(token ? { token } : {});
          };
          const abort = () => finish(null);
          if (signal.aborted) { finish(null); return; }
          signal.addEventListener('abort', abort, { once: true });
          void Promise.resolve().then(() => options.tokenProvider?.(signal) ?? null)
            .then(token => finish(signal.aborted ? null : token), () => finish(null));
        },
      });
      const wrapped: RealtimeSocket = {
        connected: () => socket.connected,
        connect() { socket.connect(); },
        disconnect() { socket.disconnect(); },
        on(event, listener) { socket.on(event, listener); return () => { socket.off(event, listener); }; },
        onConnect(listener) { socket.on('connect', listener); return () => { socket.off('connect', listener); }; },
        onDisconnect(listener) { socket.on('disconnect', listener); return () => { socket.off('disconnect', listener); }; },
        onError(listener) { socket.on('connect_error', listener); return () => { socket.off('connect_error', listener); }; },
        send(event, value, reply) {
          if (!socket.connected) throw new ApiError('network', 'realtime_disconnected', '实时连接已断开，请先核对原操作结果');
          // 库内也设回执期限，回执丢失不能留下永久的回调表项；不设置 retries。
          socket.timeout(5000).volatile.emit(event, value, (error: Error | null, data: unknown) => {
            if (!error) reply(data);
          });
        },
      };
      sockets.add(wrapped);
      return wrapped;
    },
    dispose() { for (const socket of sockets) socket.disconnect(); sockets.clear(); },
  };
};
