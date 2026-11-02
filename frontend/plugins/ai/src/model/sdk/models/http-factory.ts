import type { AiRequest } from '../../gateway.ts';
import { createAiJobGateway, readAiOperations } from '../../gateway.ts';
import type { AiSdkOptions } from '../types/index.ts';
import { createAiSdk } from './ai-sdk.ts';

export function createHttpAiSdk(transport: AiRequest, options: Omit<AiSdkOptions, 'operations'> = {}) {
  return createAiSdk(createAiJobGateway(transport), {
    ...options, operations: { list: (signal) => readAiOperations(transport, signal) },
  });
}
