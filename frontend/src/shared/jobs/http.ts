import { cancelEndpoint, jobEndpoint, submitEndpoint } from '../api/index.ts';
import type { ApiClient } from '../api/index.ts';
import type { JobGateway } from './types.ts';

// HTTP 边界复用生成契约；SDK 宿主可以直接注入三个结构相同的方法。
export function createHttpJobGateway(client: ApiClient): JobGateway {
  return {
    submit: (operation, input, signal) => client.call(submitEndpoint, { operation, input }, signal),
    getJob: (id, signal) => client.call(jobEndpoint, id, signal),
    cancelJob: (id, signal) => client.call(cancelEndpoint, id, signal),
  };
}
