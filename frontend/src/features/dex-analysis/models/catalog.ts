import { ApiError } from '../../../services/api/index.ts';
import type { OperationDto } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { isOperation } from '../../../services/api/validation.ts';
import { frozenCopy, isDefinitionSchema } from '../utils/rules.ts';
import type { DexCatalogSnapshot, DexOperationReader } from '../types/index.ts';

export const dexOperation = (action: 'inspect' | 'scan_sdks'): string => `plugin.dex-analysis.${action}`;
const isDexOperation = (id: string) => id === dexOperation('inspect') || id === dexOperation('scan_sdks');
const empty = (): DexCatalogSnapshot => Object.freeze({ operations: Object.freeze([]), refreshing: false, logId: null, error: null });
export function createDexCatalog(reader: DexOperationReader) {
  let snapshot = empty(); let revision = 0; let closed = false;
  let observation = new AbortController();
  const lifetime = new AbortController();
  const assertOpen = () => { if (closed) throw new ApiError('cancelled', 'dex_analysis_closed', 'DEX基础消费已关闭'); };
  return {
    snapshot: () => snapshot,
    requireOperation(action: 'inspect' | 'scan_sdks') {
      assertOpen();
      const id = dexOperation(action);
      if (!snapshot.operations.some((entry) => entry.id === id)) throw new ApiError('protocol', 'dex_operation_unavailable', '请先刷新公开操作目录，所需DEX贡献当前不可用');
      return id;
    },
    refresh(signal: AbortSignal) {
      assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', 'DEX目录等待已取消');
      observation.abort(); observation = new AbortController();
      const admitted = ++revision;
      const current = AbortSignal.any([signal, observation.signal, lifetime.signal]);
      snapshot = Object.freeze({ ...empty(), refreshing: true });
      return (async () => {
        try {
          const result = await abortable(reader.list(current), current);
          if (closed || current.aborted || admitted !== revision) throw new ApiError('cancelled', 'stale_result', '旧DEX操作目录已撤销', null, result.logId);
          if (!Array.isArray(result.data) || !result.data.every(isOperation)) throw new ApiError('protocol', 'invalid_dex_catalog', '公开操作目录形状无效', null, result.logId);
          const definitions: OperationDto[] = result.data.filter((entry) => isDexOperation(entry.id));
          if (definitions.some((entry) => !isDefinitionSchema(entry.input_schema)) || new Set(definitions.map((entry) => entry.id)).size !== definitions.length) throw new ApiError('protocol', 'invalid_dex_catalog', 'DEX操作目录包含错误模式或重复贡献', null, result.logId);
          const data = frozenCopy(definitions);
          snapshot = Object.freeze({ operations: data, refreshing: false, logId: result.logId, error: null });
          return { data, logId: result.logId };
        } catch (error) {
          const failure = error instanceof ApiError ? error : new ApiError('network', 'dex_catalog_failed', '无法取得DEX操作目录');
          if (!closed && admitted === revision) snapshot = Object.freeze({ ...empty(), logId: failure.logId, error: failure });
          throw failure;
        }
      })();
    },
    dispose() { if (closed) return; closed = true; ++revision; lifetime.abort(); observation.abort(); snapshot = empty(); },
  };
}
