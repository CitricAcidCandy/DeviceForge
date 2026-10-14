import { operationsEndpoint } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import { createHttpJobGateway } from '../../../shared/jobs/index.ts';
import type { JobOptions } from '../../../shared/jobs/index.ts';
import { createDexAnalysis } from './dex-analysis.ts';

export function createHttpDexAnalysis(client: ApiClient, options: JobOptions = {}) {
  return createDexAnalysis(createHttpJobGateway(client), { list: (signal) => client.call(operationsEndpoint, undefined, signal) }, options);
}
