import { ApiError } from '../../shared/api/index.ts';
import type { OperationDto } from '../../shared/api/index.ts';
import { abortable } from '../../shared/api/abort.ts';
import { isOperation } from '../../shared/api/validation.ts';
import { jsonObject } from '../../shared/jobs/index.ts';
import { frozenAutomationCopy } from './rules.ts';
import type { AutomationCatalogSnapshot, AutomationOperation, AutomationOperationReader } from './types.ts';

const actions: readonly AutomationOperation[] = Object.freeze(['sequence.run', 'click.repeat', 'windows.mouse.position', 'windows.mouse.click', 'windows.mouse.repeat', 'input_trace.record', 'input_trace.playback']);
export const automationOperation = (action: AutomationOperation): string => `plugin.automation.${action}`;
export const isAutomationOperation = (id: string): boolean => actions.some((action) => automationOperation(action) === id);
const empty = (): AutomationCatalogSnapshot => Object.freeze({ operations: Object.freeze([]), refreshing: false, logId: null, error: null });
export function createAutomationCatalog(reader: AutomationOperationReader | undefined) {
  let snapshot = empty(); let revision = 0; let closed = false;
  let observation = new AbortController(); const lifetime = new AbortController();
  const assertOpen = () => { if (closed) throw new ApiError('cancelled', 'automation_closed', '自动化基础消费已关闭'); };
  return {
    snapshot: () => snapshot,
    requireOperation(action: AutomationOperation) {
      assertOpen(); const id = automationOperation(action);
      if (reader && !snapshot.operations.some((entry) => entry.id === id)) throw new ApiError('protocol', 'automation_operation_unavailable', '请先刷新真实目录并确认自动化贡献可用');
      return id;
    },
    refresh(signal: AbortSignal) {
      assertOpen();
      if (!reader) throw new ApiError('protocol', 'automation_catalog_not_configured', '当前注入门面没有公开操作目录读取器');
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '自动化目录等待已取消');
      observation.abort(); observation = new AbortController();
      const admitted = ++revision; const current = AbortSignal.any([signal, observation.signal, lifetime.signal]);
      snapshot = Object.freeze({ ...empty(), refreshing: true });
      return (async () => {
        try {
          const response = await abortable(reader.list(current), current);
          if (closed || current.aborted || admitted !== revision) throw new ApiError('cancelled', 'stale_result', '旧自动化目录已撤销', null, response.logId);
          if (!Array.isArray(response.data) || !response.data.every(isOperation)) throw new ApiError('protocol', 'invalid_automation_catalog', '公开目录形状无效', null, response.logId);
          const definitions: OperationDto[] = response.data.filter((entry) => isAutomationOperation(entry.id));
          if (new Set(definitions.map((entry) => entry.id)).size !== definitions.length
            || definitions.some((entry) => !jsonObject(entry.input_schema) || entry.input_schema.type !== 'object')) throw new ApiError('protocol', 'invalid_automation_catalog', '自动化目录模式错误或ID重复', null, response.logId);
          const data = frozenAutomationCopy(definitions);
          snapshot = Object.freeze({ operations: data, refreshing: false, logId: response.logId, error: null }); return { data, logId: response.logId };
        } catch (error) {
          const failure = error instanceof ApiError ? error : new ApiError('network', 'automation_catalog_failed', '无法取得自动化操作目录');
          if (!closed && admitted === revision) snapshot = Object.freeze({ ...empty(), logId: failure.logId, error: Object.freeze(failure) });
          throw failure;
        }
      })();
    },
    dispose() { if (closed) return; closed = true; ++revision; lifetime.abort(); observation.abort(); snapshot = empty(); },
  };
}
