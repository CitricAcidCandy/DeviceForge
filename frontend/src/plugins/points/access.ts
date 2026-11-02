import type { Dispose } from '../../plugin-sdk/models.ts';
import type { PointAccess, PointRef } from '../../plugin-sdk/points.ts';
import { current } from './rules.ts';

export interface PointOwner {
  readonly pluginId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly track: (release: Dispose) => Dispose;
}

/** 所有权交给现有 track，信号另负责立即撤销，不建立平行生命周期队列。 */
export function bindPointRelease(signal: AbortSignal, track: PointOwner['track'], cleanup: Dispose): Dispose {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', abort);
    return cleanup();
  };
  // 中止也经过原 track 返回的资源句柄，异步清理因此进入原作用域的等待与错误汇总。
  const abort = () => { void tracked(); };
  const tracked = track(release);
  if (!released) {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) void tracked();
  }
  return tracked;
}

/** 面板和功能子作用域不继承根上下文的资源寿命。 */
export function scopedPointAccess(upstream: PointAccess, signal: AbortSignal,
  track: PointOwner['track']): PointAccess;
export function scopedPointAccess(upstream: PointAccess | undefined, signal: AbortSignal,
  track: PointOwner['track']): PointAccess | undefined;
export function scopedPointAccess(upstream: PointAccess | undefined, signal: AbortSignal,
  track: PointOwner['track']): PointAccess | undefined {
  if (!upstream) return undefined;
  const readSelection = upstream.selection;
  return Object.freeze<PointAccess>({
    define(definition) {
      current(signal);
      const release = upstream.define(definition);
      return bindPointRelease(signal, track, release);
    },
    contribute(contribution) {
      current(signal);
      const handle = upstream.contribute(contribution);
      let released = false;
      const dispose = bindPointRelease(signal, track, () => {
        released = true;
        return handle.dispose();
      });
      return {
        update(value) {
          current(signal);
          if (released) throw new Error('扩展点贡献已撤销');
          handle.update(value);
        },
        dispose,
      };
    },
    catalog() { current(signal); return upstream.catalog(); },
    list(point) { current(signal); return upstream.list(point); },
    selected(point) { current(signal); return upstream.selected(point); },
    ...(readSelection ? { selection(point: PointRef) { current(signal); return readSelection.call(upstream, point); } } : {}),
    select(point, id) { current(signal); upstream.select(point, id); },
    subscribe(listener) {
      current(signal);
      const release = upstream.subscribe(() => { if (!signal.aborted) listener(); });
      return bindPointRelease(signal, track, release);
    },
  });
}
