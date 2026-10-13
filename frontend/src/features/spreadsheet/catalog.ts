import { ApiError } from '../../shared/api/index.ts';
import type { OperationDto } from '../../shared/api/index.ts';
import { abortable } from '../../shared/api/abort.ts';
import { isOperation } from '../../shared/api/validation.ts';
import { frozenCopy, isDefinitionSchema } from './rules.ts';
import type { SpreadsheetCatalogSnapshot, SpreadsheetOperationReader } from './types.ts';

export const spreadsheetOperation = (action: 'inspect' | 'read'): string => 'plugin.spreadsheet.' + action;
const isSpreadsheetOperation = (id: string) => id === spreadsheetOperation('inspect') || id === spreadsheetOperation('read');
const empty = (): SpreadsheetCatalogSnapshot => Object.freeze({ operations: Object.freeze([]), refreshing: false, logId: null, error: null });
export function createSpreadsheetCatalog(reader: SpreadsheetOperationReader) {
  let snapshot = empty(); let revision = 0; let closed = false;
  let observation = new AbortController(); const lifetime = new AbortController();
  const assertOpen = () => { if (closed) throw new ApiError('cancelled', 'spreadsheet_closed', '表格基础消费已关闭'); };
  return {
    snapshot: () => snapshot,
    requireOperation(action: 'inspect' | 'read') {
      assertOpen(); const id = spreadsheetOperation(action);
      if (!snapshot.operations.some((entry) => entry.id === id)) throw new ApiError('protocol', 'spreadsheet_operation_unavailable', '请先刷新公开操作目录，所需表格贡献当前不可用');
      return id;
    },
    refresh(signal: AbortSignal) {
      assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '表格目录等待已取消');
      observation.abort(); observation = new AbortController();
      const admitted = ++revision; const current = AbortSignal.any([signal, observation.signal, lifetime.signal]);
      snapshot = Object.freeze({ ...empty(), refreshing: true });
      return (async () => {
        try {
          const result = await abortable(reader.list(current), current);
          if (closed || current.aborted || admitted !== revision) throw new ApiError('cancelled', 'stale_result', '旧表格操作目录已撤销', null, result.logId);
          if (!Array.isArray(result.data) || !result.data.every(isOperation)) throw new ApiError('protocol', 'invalid_spreadsheet_catalog', '公开操作目录形状无效', null, result.logId);
          const definitions: OperationDto[] = result.data.filter((entry) => isSpreadsheetOperation(entry.id));
          if (definitions.some((entry) => !isDefinitionSchema(entry.input_schema)) || new Set(definitions.map((entry) => entry.id)).size !== definitions.length) throw new ApiError('protocol', 'invalid_spreadsheet_catalog', '表格操作目录包含错误模式或重复贡献', null, result.logId);
          const data = frozenCopy(definitions); snapshot = Object.freeze({ operations: data, refreshing: false, logId: result.logId, error: null });
          return { data, logId: result.logId };
        } catch (error) {
          const failure = error instanceof ApiError ? error : new ApiError('network', 'spreadsheet_catalog_failed', '无法取得表格操作目录');
          if (!closed && admitted === revision) snapshot = Object.freeze({ ...empty(), logId: failure.logId, error: failure });
          throw failure;
        }
      })();
    },
    dispose() { if (closed) return; closed = true; ++revision; lifetime.abort(); observation.abort(); snapshot = empty(); },
  };
}
