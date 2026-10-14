import { createHttpSessionGateway } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import type { AiStreamingOptions } from '../types/index.ts';
import { createAiStreaming } from './ai-streaming.ts';

export function createHttpAiStreaming(client: ApiClient, options: AiStreamingOptions = {}) {
  return createAiStreaming(createHttpSessionGateway(client), options);
}
