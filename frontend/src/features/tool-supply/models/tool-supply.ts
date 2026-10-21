import { ApiError } from '../../../services/api/index.ts';
import { createJobRunner } from '../../../shared/jobs/index.ts';
import type { JobGateway, JobOptions, JobTicket } from '../../../shared/jobs/index.ts';
import { createRuntimeFeature, isRuntimeFeatureOperation } from './feature.ts';
import { decodeCatalog, decodeInstallation, decodePlan, decodeRemoval } from '../utils/results.ts';
import { requireModuleId, requireSelection } from '../utils/rules.ts';
import type { ToolLocalImport, ToolSupplyAction } from '../types/index.ts';
import { decodeLocalInstallation, localImportInput } from '../utils/local-import.ts';

export type * from '../types/index.ts';
export function createToolSupply(gateway: JobGateway, options: JobOptions = {}) {
  const jobs = createJobRunner(gateway, options);
  const operation = (action: ToolSupplyAction) => `plugin.tool-supply.${action}`;
  function checkTicket(action: ToolSupplyAction, ticket: JobTicket): void {
    if (ticket.operation !== operation(action))
      throw new ApiError('protocol', 'invalid_tool_ticket', '恢复任务与工具供应操作不匹配');
  }
  function checkModuleTicket(ticket: JobTicket): void {
    if (
      !['catalog', 'plan', 'install', 'import', 'remove'].some(
        (action) => ticket.operation === `plugin.tool-supply.${action}`,
      ) &&
      !isRuntimeFeatureOperation(ticket.operation)
    )
      throw new ApiError('protocol', 'invalid_tool_ticket', '任务不属于工具供应模块');
  }
  return {
    ...createRuntimeFeature(jobs),
    catalog: (signal: AbortSignal) => jobs.execute(operation('catalog'), {}, signal, decodeCatalog),
    plan(moduleIds: readonly string[], signal: AbortSignal) {
      requireSelection(moduleIds);
      const selected = [...moduleIds];
      return jobs.execute(operation('plan'), { module_ids: selected }, signal, (value, logId) =>
        decodePlan(value, logId, selected),
      );
    },
    install(moduleId: string, signal: AbortSignal) {
      requireModuleId(moduleId);
      return jobs.execute(operation('install'), { module_id: moduleId }, signal, (value, logId) =>
        decodeInstallation(value, logId, moduleId),
      );
    },
    importLocal(input: ToolLocalImport, signal: AbortSignal) {
      return jobs.execute(operation('import'), localImportInput(input), signal, (value, logId) =>
        decodeLocalInstallation(value, logId, input.module_id),
      );
    },
    remove(moduleId: string, signal: AbortSignal) {
      requireModuleId(moduleId);
      return jobs.execute(operation('remove'), { module_id: moduleId }, signal, (value, logId) =>
        decodeRemoval(value, logId, moduleId),
      );
    },
    resumeCatalog(ticket: JobTicket, signal: AbortSignal) {
      checkTicket('catalog', ticket);
      return jobs.resume(ticket, signal, decodeCatalog);
    },
    resumePlan(ticket: JobTicket, moduleIds: readonly string[], signal: AbortSignal) {
      checkTicket('plan', ticket);
      requireSelection(moduleIds);
      const selected = [...moduleIds];
      return jobs.resume(ticket, signal, (value, logId) => decodePlan(value, logId, selected));
    },
    resumeInstall(ticket: JobTicket, moduleId: string, signal: AbortSignal) {
      checkTicket('install', ticket);
      requireModuleId(moduleId);
      return jobs.resume(ticket, signal, (value, logId) =>
        decodeInstallation(value, logId, moduleId),
      );
    },
    resumeRemove(ticket: JobTicket, moduleId: string, signal: AbortSignal) {
      checkTicket('remove', ticket);
      requireModuleId(moduleId);
      return jobs.resume(ticket, signal, (value, logId) => decodeRemoval(value, logId, moduleId));
    },
    resumeImport(ticket: JobTicket, moduleId: string, signal: AbortSignal) {
      checkTicket('import', ticket);
      requireModuleId(moduleId);
      return jobs.resume(ticket, signal, (value, logId) => decodeLocalInstallation(value, logId, moduleId));
    },
    query(ticket: JobTicket, signal: AbortSignal) {
      checkModuleTicket(ticket);
      return jobs.query(ticket, signal);
    },
    cancel(ticket: JobTicket, signal: AbortSignal) {
      checkModuleTicket(ticket);
      return jobs.cancel(ticket, signal);
    },
    dispose: jobs.dispose,
  };
}
