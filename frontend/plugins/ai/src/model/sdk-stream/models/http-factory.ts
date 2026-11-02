import type { AiRequest } from '../../gateway.ts';
import { createAiSessionGateway } from '../../gateway.ts';
import type { AiSdkStreamingOptions } from '../types/index.ts';
import { createAiSdkStreaming } from './ai-sdk-streaming.ts';

export function createHttpAiSdkStreaming(transport: AiRequest, options: AiSdkStreamingOptions = {}) {
  return createAiSdkStreaming(createAiSessionGateway(transport), options);
}
