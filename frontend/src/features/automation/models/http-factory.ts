import { operationsEndpoint } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import { createHttpJobGateway } from '../../../shared/jobs/index.ts';
import type { AutomationOptions } from '../types/index.ts';
import { createAutomation } from './automation.ts';

export function createHttpAutomation(client: ApiClient, options: Omit<AutomationOptions, 'operations'> = {}) {
  return createAutomation(createHttpJobGateway(client), { ...options, operations: { list: (signal) => client.call(operationsEndpoint, undefined, signal) } },
    { download: (id, signal) => client.downloadArtifact(id, signal) });
}
