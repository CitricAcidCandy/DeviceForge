import type { ApiClient } from '../../../shared/api/index.ts';
import { createHttpPerformanceGateway } from '../services/http.ts';
import type { PerformanceOptions } from '../types/index.ts';
import { createPerformance } from './performance.ts';

export function createHttpPerformance(client: ApiClient, options: PerformanceOptions = {}) {
  return createPerformance(createHttpPerformanceGateway(client), options);
}
