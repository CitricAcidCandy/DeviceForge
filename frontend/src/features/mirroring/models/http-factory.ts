import { operationsEndpoint } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import { createHttpJobGateway } from '../../../shared/jobs/index.ts';
import type { MirroringOptions } from '../types/index.ts';
import { createMirroring } from './mirroring.ts';

export function createHttpMirroring(client: ApiClient, options: Omit<MirroringOptions, 'operations'> = {}) {
  return createMirroring(createHttpJobGateway(client), { download: (id, signal) => client.downloadArtifact(id, signal) },
    { ...options, operations: { list: (signal) => client.call(operationsEndpoint, undefined, signal) } });
}
