import { ApiError, operationsEndpoint } from '../../shared/api/index.ts';
import type { ApiClient } from '../../shared/api/index.ts';
import { createHttpJobGateway, createJobRunner } from '../../shared/jobs/index.ts';
import type { JobGateway, JobOptions, JobTicket } from '../../shared/jobs/index.ts';
import { createDexCatalog, dexOperation } from './catalog.ts';
import { normalizeInspect, normalizeScan } from './rules.ts';
import { decodeInspection, decodeScan } from './results.ts';
import type { DexArtifactInput, DexOperationReader, DexScanInput } from './types.ts';

export type * from './types.ts';
function checkTicket(ticket: JobTicket, action?: 'inspect' | 'scan_sdks'): void {
  if (action ? ticket.operation !== dexOperation(action) : ticket.operation !== dexOperation('inspect') && ticket.operation !== dexOperation('scan_sdks')) throw new ApiError('protocol', 'invalid_dex_ticket', '任务票据不属于所选DEX操作');
}
export function createDexAnalysis(gateway: JobGateway, operations: DexOperationReader, options: JobOptions = {}) {
  const jobs = createJobRunner(gateway, options); const catalog = createDexCatalog(operations);
  return {
    refreshOperations: catalog.refresh,
    snapshot: catalog.snapshot,
    inspect(input: DexArtifactInput, signal: AbortSignal) {
      const normalized = normalizeInspect(input); const operation = catalog.requireOperation('inspect');
      return jobs.execute(operation, normalized, signal, (value, logId) => decodeInspection(value, logId, normalized));
    },
    scanSdks(input: DexScanInput, signal: AbortSignal) {
      const normalized = normalizeScan(input); const operation = catalog.requireOperation('scan_sdks');
      return jobs.execute(operation, normalized, signal, (value, logId) => decodeScan(value, logId, normalized));
    },
    resumeInspect(ticket: JobTicket, input: DexArtifactInput, signal: AbortSignal) {
      checkTicket(ticket, 'inspect'); const normalized = normalizeInspect(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeInspection(value, logId, normalized));
    },
    resumeScanSdks(ticket: JobTicket, input: DexScanInput, signal: AbortSignal) {
      checkTicket(ticket, 'scan_sdks'); const normalized = normalizeScan(input);
      return jobs.resume(ticket, signal, (value, logId) => decodeScan(value, logId, normalized));
    },
    queryJob(ticket: JobTicket, signal: AbortSignal) { checkTicket(ticket); return jobs.query(ticket, signal); },
    cancel(ticket: JobTicket, signal: AbortSignal) { checkTicket(ticket); return jobs.cancel(ticket, signal); },
    dispose() { catalog.dispose(); jobs.dispose(); },
  };
}
export function createHttpDexAnalysis(client: ApiClient, options: JobOptions = {}) {
  return createDexAnalysis(createHttpJobGateway(client), { list: (signal) => client.call(operationsEndpoint, undefined, signal) }, options);
}
