import { createHttpSessionGateway } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import type { AiSdkStreamingOptions } from '../types/index.ts';
import { createAiSdkStreaming } from './ai-sdk-streaming.ts';

export function createHttpAiSdkStreaming(client: ApiClient, options: AiSdkStreamingOptions = {}) {
  return createAiSdkStreaming(createHttpSessionGateway(client), options);
}
