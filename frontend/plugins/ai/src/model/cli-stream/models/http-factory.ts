import type { AiRequest } from '../../gateway.ts';
import { createAiSessionGateway } from '../../gateway.ts';
import type { AiStreamingOptions } from '../types/index.ts';
import { createAiStreaming } from './ai-streaming.ts';

export function createHttpAiStreaming(transport: AiRequest, options: AiStreamingOptions = {}) {
  return createAiStreaming(createAiSessionGateway(transport), options);
}
