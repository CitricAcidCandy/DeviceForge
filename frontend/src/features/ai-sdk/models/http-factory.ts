import { operationsEndpoint } from '../../../shared/api/index.ts';
import type { ApiClient } from '../../../shared/api/index.ts';
import { createHttpJobGateway } from '../../../shared/jobs/index.ts';
import type { AiSdkOptions } from '../types/index.ts';
import { createAiSdk } from './ai-sdk.ts';

export function createHttpAiSdk(client: ApiClient, options: Omit<AiSdkOptions, 'operations'> = {}) {
  return createAiSdk(createHttpJobGateway(client), { ...options, operations: { list: (signal) => client.call(operationsEndpoint, undefined, signal) } });
}
