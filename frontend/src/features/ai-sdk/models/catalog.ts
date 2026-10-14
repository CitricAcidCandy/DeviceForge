import { ApiError } from '../../../services/api/index.ts';
import type { OperationDto } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { isOperation } from '../../../services/api/validation.ts';
import { jsonObject } from '../../../shared/jobs/index.ts';
import { frozenAiSdkCopy } from '../utils/rules.ts';
import type { AiSdkAction, AiSdkCatalogSnapshot, AiSdkOperationReader } from '../types/index.ts';

const actions: readonly AiSdkAction[] = Object.freeze(['runtime.status', 'sdk.single', 'sdk.turn', 'session.get', 'session.close', 'assistant.run']);
export const aiSdkOperation = (action: AiSdkAction): string => `plugin.ai-sdk.${action}`;
export const isAiSdkOperation = (id: string): boolean => actions.some((action) => aiSdkOperation(action) === id);
const empty = (): AiSdkCatalogSnapshot => Object.freeze({ operations: Object.freeze([]), refreshing: false, logId: null, error: null });
export function createAiSdkCatalog(reader: AiSdkOperationReader | undefined) {
  let snapshot = empty(); let revision = 0; let closed = false;
  let observation = new AbortController(); const lifetime = new AbortController();
  const assertOpen = () => { if (closed) throw new ApiError('cancelled', 'ai_sdk_closed', 'SDK基础消费已关闭'); };
  return {
    snapshot: () => snapshot,
    requireOperation(action: AiSdkAction) {
      assertOpen(); const id = aiSdkOperation(action);
      if (!snapshot.operations.some((entry) => entry.id === id)) throw new ApiError('protocol', 'ai_sdk_operation_unavailable', '请先刷新真实目录并确认SDK贡献可用');
      return id;
    },
    refresh(signal: AbortSignal) {
      assertOpen();
      if (!reader) throw new ApiError('protocol', 'ai_sdk_catalog_not_configured', '未配置SDK公开操作目录读取器');
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', 'SDK目录等待已取消');
      observation.abort(); observation = new AbortController();
      const admitted = ++revision; const current = AbortSignal.any([signal, observation.signal, lifetime.signal]);
      snapshot = Object.freeze({ ...empty(), refreshing: true });
      return (async () => {
        try {
          const response = await abortable(reader.list(current), current);
          if (closed || current.aborted || admitted !== revision) throw new ApiError('cancelled', 'stale_result', '旧SDK目录已撤销', null, response.logId);
          if (!Array.isArray(response.data) || !response.data.every(isOperation)) throw new ApiError('protocol', 'invalid_ai_sdk_catalog', '公开目录形状无效', null, response.logId);
          const definitions: OperationDto[] = response.data.filter((entry) => isAiSdkOperation(entry.id));
          if (new Set(definitions.map((entry) => entry.id)).size !== definitions.length
            || definitions.some((entry) => !jsonObject(entry.input_schema) || entry.input_schema.type !== 'object')) throw new ApiError('protocol', 'invalid_ai_sdk_catalog', 'SDK目录模式错误或ID重复', null, response.logId);
          const data = frozenAiSdkCopy(definitions);
          snapshot = Object.freeze({ operations: data, refreshing: false, logId: response.logId, error: null }); return { data, logId: response.logId };
        } catch (error) {
          const failure = error instanceof ApiError ? error : new ApiError('network', 'ai_sdk_catalog_failed', '无法取得SDK操作目录');
          if (!closed && admitted === revision) snapshot = Object.freeze({ ...empty(), logId: failure.logId, error: Object.freeze(failure) });
          throw failure;
        }
      })();
    },
    dispose() { if (closed) return; closed = true; ++revision; lifetime.abort(); observation.abort(); snapshot = empty(); },
  };
}
