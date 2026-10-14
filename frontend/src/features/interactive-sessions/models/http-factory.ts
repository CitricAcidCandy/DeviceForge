import { createHttpSessionGateway } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import type { InteractiveSessionOptions } from '../types/index.ts';
import { createInteractiveSessions } from './interactive-sessions.ts';

export function createHttpInteractiveSessions(client: ApiClient, options: InteractiveSessionOptions = {}) {
  return createInteractiveSessions(createHttpSessionGateway(client), options);
}
