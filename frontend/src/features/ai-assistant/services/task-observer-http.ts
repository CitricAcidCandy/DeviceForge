import { eventsEndpoint } from '../../../shared/api/index.ts';
import type { ApiClient } from '../../../shared/api/index.ts';
import { createHttpJobGateway } from '../../../shared/jobs/index.ts';
import type { AiTaskGateway } from '../types/task-events.ts';

export function createHttpAiTaskGateway(client: ApiClient): AiTaskGateway {
  return {
    ...createHttpJobGateway(client),
    getEvents: (id, query, signal) => client.call(eventsEndpoint, { id, query }, signal),
  };
}
