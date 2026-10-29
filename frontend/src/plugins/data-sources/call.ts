import { HostError } from '../../plugin-sdk/models.ts';
import type { HostResult } from '../../plugin-sdk/models.ts';

/** 只收敛等待和隔离旧结果，不宣称已停止服务或回滚后台写入。 */
export function awaitDataCall<T>(signal: AbortSignal, execute: () => Promise<HostResult<T>>): Promise<HostResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(new HostError('cancelled', 'data_source_revoked', '数据等待已取消，变更结果需另行查询'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new HostError('cancelled', 'data_source_revoked', '数据访问已撤销');
      return execute();
    }).then((result) => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; resolve(result); }
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
  });
}
