import { ApiError } from '../../../services/api/index.ts';
import { createJobRunner } from '../../../shared/jobs/index.ts';
import type { JobGateway, JobOptions, JobTicket } from '../../../shared/jobs/index.ts';
import { createSpreadsheetCatalog, spreadsheetOperation } from './catalog.ts';
import { normalizeInspect, normalizeRead } from '../utils/rules.ts';
import { decodeInspection, decodePage } from '../utils/results.ts';
import type { SpreadsheetArtifactInput, SpreadsheetOperationReader, SpreadsheetReadInput } from '../types/index.ts';
export type * from '../types/index.ts';
export { buildFieldMapping, isEmptyImportCell, prepareSpreadsheetImportPage, requiredUnmappedFields } from '../utils/mapping.ts';
function checkTicket(ticket: JobTicket, action?: 'inspect' | 'read'): void {
  if (action ? ticket.operation !== spreadsheetOperation(action) : ticket.operation !== spreadsheetOperation('inspect') && ticket.operation !== spreadsheetOperation('read')) throw new ApiError('protocol', 'invalid_spreadsheet_ticket', '任务票据不属于所选表格操作');
}
export function createSpreadsheet(gateway: JobGateway, operations: SpreadsheetOperationReader, options: JobOptions = {}) {
  const jobs = createJobRunner(gateway, options); const catalog = createSpreadsheetCatalog(operations);
  return {
    refreshOperations: catalog.refresh,
    snapshot: catalog.snapshot,
    inspect(input: SpreadsheetArtifactInput, signal: AbortSignal) {
      const normalized = normalizeInspect(input); const operation = catalog.requireOperation('inspect');
      return jobs.execute(operation, normalized, signal, (value, logId) => decodeInspection(value, logId, normalized));
    },
    read(input: SpreadsheetReadInput, signal: AbortSignal) {
      const normalized = normalizeRead(input); const operation = catalog.requireOperation('read');
      return jobs.execute(operation, normalized, signal, (value, logId) => decodePage(value, logId, normalized));
    },
    resumeInspect(ticket: JobTicket, input: SpreadsheetArtifactInput, signal: AbortSignal) {
      checkTicket(ticket, 'inspect'); const normalized = normalizeInspect(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeInspection(value, logId, normalized));
    },
    resumeRead(ticket: JobTicket, input: SpreadsheetReadInput, signal: AbortSignal) {
      checkTicket(ticket, 'read'); const normalized = normalizeRead(input);
      return jobs.resume(ticket, signal, (value, logId) => decodePage(value, logId, normalized));
    },
    queryJob(ticket: JobTicket, signal: AbortSignal) { checkTicket(ticket); return jobs.query(ticket, signal); },
    cancel(ticket: JobTicket, signal: AbortSignal) { checkTicket(ticket); return jobs.cancel(ticket, signal); },
    dispose() { catalog.dispose(); jobs.dispose(); },
  };
}
