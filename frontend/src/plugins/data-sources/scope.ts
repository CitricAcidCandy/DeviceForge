import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose } from '../../plugin-sdk/models.ts';
import type { DataAccess } from '../../plugin-sdk/data-sources.ts';
import { awaitDataCall } from './call.ts';

/** 子作用域只能登记自身资源；退出后撤销调用资格，不保存上代订阅。 */
export function scopedDataAccess(upstream: DataAccess | undefined, signal: AbortSignal, track: (dispose: Dispose) => Dispose): DataAccess | undefined {
  if (!upstream) return undefined;
  const current = () => {
    if (signal.aborted) throw new HostError('cancelled', 'data_source_revoked', '数据访问所属作用域已撤销');
  };
  return Object.freeze<DataAccess>({
    register(definition) { current(); return track(upstream.register(definition)); },
    catalog() { current(); return upstream.catalog(); },
    read: async (ref, caller) => {
      current(); const combined = AbortSignal.any([signal, caller]);
      return awaitDataCall(combined, () => upstream.read(ref, combined));
    },
    write: async (ref, value, caller) => {
      current(); const combined = AbortSignal.any([signal, caller]);
      return awaitDataCall(combined, () => upstream.write(ref, value, combined));
    },
    subscribe(listener) { current(); return track(upstream.subscribe(() => { if (!signal.aborted) listener(); })); },
  });
}
