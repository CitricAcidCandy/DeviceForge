import { createHttpSessionGateway } from '../../../shared/api/index.ts';
import type { ApiClient } from '../../../shared/api/index.ts';
import type { AiSdkStreamingOptions } from '../domain/types.ts';
import { createAiSdkStreaming } from './ai-sdk-streaming.ts';

export function createHttpAiSdkStreaming(client: ApiClient, options: AiSdkStreamingOptions = {}) {
  return createAiSdkStreaming(createHttpSessionGateway(client), options);
}
