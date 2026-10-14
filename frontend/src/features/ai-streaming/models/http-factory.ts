import { createHttpSessionGateway } from '../../../shared/api/index.ts';
import type { ApiClient } from '../../../shared/api/index.ts';
import type { AiStreamingOptions } from '../types/index.ts';
import { createAiStreaming } from './ai-streaming.ts';

export function createHttpAiStreaming(client: ApiClient, options: AiStreamingOptions = {}) {
  return createAiStreaming(createHttpSessionGateway(client), options);
}
