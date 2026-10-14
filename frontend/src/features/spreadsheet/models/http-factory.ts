import { operationsEndpoint } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import { createHttpJobGateway } from '../../../shared/jobs/index.ts';
import type { JobOptions } from '../../../shared/jobs/index.ts';
import { createSpreadsheet } from './spreadsheet.ts';

export function createHttpSpreadsheet(client: ApiClient, options: JobOptions = {}) {
  return createSpreadsheet(
    createHttpJobGateway(client),
    { list: (signal) => client.call(operationsEndpoint, undefined, signal) },
    options,
  );
}
