import { HostError } from '../plugin-sdk/models.ts';
import type { Dispose, HostResult } from '../plugin-sdk/models.ts';
import type { PluginTransport } from '../plugin-sdk/transport.ts';

/** 包装既有通信能力，撤销子作用域时不保留上代请求或可读流。 */
export function scopedTransportAccess(
  upstream: PluginTransport,
  lifetime: AbortSignal,
  track: (dispose: Dispose) => Dispose,
): PluginTransport;
export function scopedTransportAccess(
  upstream: PluginTransport | undefined,
  lifetime: AbortSignal,
  track: (dispose: Dispose) => Dispose,
): PluginTransport | undefined;
export function scopedTransportAccess(
  upstream: PluginTransport | undefined,
  lifetime: AbortSignal,
  track: (dispose: Dispose) => Dispose,
): PluginTransport | undefined {
  if (!upstream) return undefined;
  async function call<T>(
    signal: AbortSignal,
    request: (combined: AbortSignal) => Promise<HostResult<T>>,
    late?: (value: T) => void,
  ): Promise<HostResult<T>> {
    const combined = AbortSignal.any([signal, lifetime]);
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        reject(new HostError('cancelled', 'plugin_unloaded', '请求所属插件或界面已撤销'));
      };
      if (combined.aborted) { abort(); return; }
      combined.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        if (combined.aborted) throw new HostError('cancelled', 'cancelled', '请求等待已取消');
        return request(combined);
      }).then((result) => {
        combined.removeEventListener('abort', abort);
        if (settled || combined.aborted) { late?.(result.data); return; }
        settled = true;
        resolve(result);
      }, (error: unknown) => {
        combined.removeEventListener('abort', abort);
        if (!settled) { settled = true; reject(error); }
      });
    });
  }
  return Object.freeze<PluginTransport>({
    request: (spec, signal) => call(signal, (combined) => upstream.request(spec, combined)),
    bytes: (spec, signal) => call(signal, (combined) => upstream.bytes(spec, combined)),
    stream: async (spec, signal) => {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, lifetime, controller.signal]);
      const release = track(() => { controller.abort(); });
      try {
        const result = await call(combined, (current) => upstream.stream(spec, current), (stream) => {
          void stream.cancel().catch(() => undefined);
        });
        const reader = result.data.getReader();
        let finished = false;
        let output: ReadableStreamDefaultController<Uint8Array>;
        const finish = () => {
          if (finished) return;
          finished = true;
          combined.removeEventListener('abort', abort);
          void release();
        };
        const cancelReader = () => { void reader.cancel().catch(() => undefined); };
        const abort = () => {
          if (finished) return;
          finish();
          cancelReader();
          output.error(new HostError('cancelled', 'plugin_unloaded', '可读流所属插件或界面已撤销', result.logId));
        };
        const stream = new ReadableStream<Uint8Array>({
          start(target) { output = target; combined.addEventListener('abort', abort, { once: true }); },
          async pull(target) {
            try {
              if (finished) return;
              if (combined.aborted) { abort(); return; }
              const value = await reader.read();
              if (finished) return;
              if (value.done) { target.close(); finish(); }
              else target.enqueue(value.value);
            } catch (error) { if (!finished) { target.error(error); finish(); } }
          },
          cancel() { cancelReader(); finish(); },
        });
        if (combined.aborted) abort();
        return { data: stream, logId: result.logId };
      } catch (error) { void release(); throw error; }
    },
  });
}
