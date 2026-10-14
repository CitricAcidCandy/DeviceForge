import { ApiError } from '../../../services/api/index.ts';
import type { OperationDto } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { isOperation } from '../../../services/api/validation.ts';
import { jsonObject } from '../../../shared/jobs/index.ts';
import { frozenFridaCopy } from '../utils/rules.ts';
import type { FridaAction, FridaCatalogSnapshot, FridaOperationReader } from '../types/index.ts';

export const fridaActions: readonly FridaAction[] = ['server.deploy', 'server.status', 'server.run', 'processes', 'script.run', 'permissions.analyze'];
export const fridaOperation = (action: FridaAction): string => `plugin.frida.${action}`;
export const isFridaOperation = (id: string): boolean => fridaActions.some((action) => fridaOperation(action) === id);
const empty = (): FridaCatalogSnapshot => Object.freeze({ operations: Object.freeze([]), refreshing: false, logId: null, error: null });
export function createFridaCatalog(reader: FridaOperationReader | undefined) {
  let snapshot = empty(); let revision = 0; let closed = false;
  let observation = new AbortController();
  const lifetime = new AbortController();
  const assertOpen = () => { if (closed) throw new ApiError('cancelled', 'frida_closed', 'Frida基础消费已关闭'); };
  return {
    snapshot: () => snapshot,
    requireOperation(action: FridaAction) {
      assertOpen();
      const id = fridaOperation(action);
      if (reader && !snapshot.operations.some((entry) => entry.id === id)) throw new ApiError('protocol', 'frida_operation_unavailable', '请先刷新真实操作目录并确认Frida贡献可用');
      return id;
    },
    refresh(signal: AbortSignal) {
      assertOpen();
      if (!reader) throw new ApiError('protocol', 'frida_catalog_not_configured', '当前注入门面没有公开操作目录读取器');
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', 'Frida目录等待已取消');
      observation.abort(); observation = new AbortController();
      const admitted = ++revision;
      const current = AbortSignal.any([signal, observation.signal, lifetime.signal]);
      snapshot = Object.freeze({ ...empty(), refreshing: true });
      return (async () => {
        try {
          const response = await abortable(reader.list(current), current);
          if (closed || current.aborted || admitted !== revision) throw new ApiError('cancelled', 'stale_result', '旧Frida目录已撤销', null, response.logId);
          if (!Array.isArray(response.data) || !response.data.every(isOperation)) throw new ApiError('protocol', 'invalid_frida_catalog', '公开操作目录形状无效', null, response.logId);
          const definitions: OperationDto[] = response.data.filter((entry) => isFridaOperation(entry.id));
          if (new Set(definitions.map((entry) => entry.id)).size !== definitions.length
            || definitions.some((entry) => !jsonObject(entry.input_schema) || entry.input_schema.type !== 'object')) throw new ApiError('protocol', 'invalid_frida_catalog', 'Frida贡献目录模式错误或ID重复', null, response.logId);
          const data = frozenFridaCopy(definitions);
          snapshot = Object.freeze({ operations: data, refreshing: false, logId: response.logId, error: null });
          return { data, logId: response.logId };
        } catch (error) {
          const failure = error instanceof ApiError ? error : new ApiError('network', 'frida_catalog_failed', '无法取得Frida操作目录');
          if (!closed && admitted === revision) snapshot = Object.freeze({ ...empty(), logId: failure.logId, error: Object.freeze(failure) });
          throw failure;
        }
      })();
    },
    dispose() { if (closed) return; closed = true; ++revision; lifetime.abort(); observation.abort(); snapshot = empty(); },
  };
}
