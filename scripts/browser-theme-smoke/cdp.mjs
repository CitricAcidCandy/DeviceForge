import { bounded } from '../unified-discovery-browser/lifecycle.mjs';

export async function themeProtocol(url, evidence) {
  const socket = new WebSocket(url),
    pending = new Map();
  let sequence = 0,
    closed = false;
  const rejectPending = (message) => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };
  socket.addEventListener('close', (event) => {
    evidence.socket_events.push({ at: new Date().toISOString(), code: event.code });
    rejectPending('主题浏览器调试连接已关闭');
  });
  socket.addEventListener('error', () => rejectPending('主题浏览器调试连接失败'));
  socket.addEventListener('message', (event) => {
    let reply;
    try {
      reply = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.error)
      entry.reject(
        new Error('主题浏览器调试命令失败：' + entry.method + '（' + reply.error.code + '）'),
      );
    else entry.resolve(reply.result);
  });
  try {
    await bounded(
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('主题调试连接失败')), {
          once: true,
        });
        socket.addEventListener('close', () => reject(new Error('主题调试连接提前关闭')), {
          once: true,
        });
      }),
      10000,
      '主题调试连接建立超时',
    );
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    call(method, params = {}, timeout = 30000) {
      if (closed || socket.readyState !== WebSocket.OPEN)
        return Promise.reject(new Error('主题调试连接不可调用：' + method));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('主题调试命令超时：' + method));
        }, timeout);
        pending.set(id, { resolve, reject, timer, method });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    close() {
      socket.close();
    },
  };
}
