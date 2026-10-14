import { createHttpSessionGateway } from '../../../shared/api/index.ts';
import type { ApiClient } from '../../../shared/api/index.ts';
import type { InteractiveSessionOptions } from '../domain/types.ts';
import { createInteractiveSessions } from './interactive-sessions.ts';

export function createHttpInteractiveSessions(client: ApiClient, options: InteractiveSessionOptions = {}) {
  return createInteractiveSessions(createHttpSessionGateway(client), options);
}
