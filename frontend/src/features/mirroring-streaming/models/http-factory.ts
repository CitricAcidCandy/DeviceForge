import { createHttpSessionGateway } from '../../../shared/api/index.ts';
import type { ApiClient } from '../../../shared/api/index.ts';
import type { MirroringStreamingOptions } from '../types/index.ts';
import { createMirroringStreaming } from './mirroring-streaming.ts';

export function createHttpMirroringStreaming(client: ApiClient, options: MirroringStreamingOptions = {}) { return createMirroringStreaming(createHttpSessionGateway(client), options); }
