import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;

export async function createFactories(context) {
  const source = join(context.snapshotRoot, 'frontend/src');
  const { createApiClient } = await import(pathToFileURL(join(source, 'shared/api/index.ts')).href);
  const { createHttpPerformance } = await import(pathToFileURL(join(source, 'features/performance/index.ts')).href);
  const { createFrontendRuntime } = await import(pathToFileURL(join(source, 'app/runtime.ts')).href);
  const transport = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, context.host.client.base);
    const response = await fetch(input, options);
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, uuid); context.host.client.logIds.add(logId);
    const record = { client_method: 'frontend-factory', path: url.pathname + url.search,
      method: options?.method ?? 'GET', status: response.status, log_id: logId, outcome: 'returned' };
    context.report.requests.push(record);
    if (record.method === 'POST' && url.pathname === '/api/v2/jobs' && response.status === 202) {
      const body = JSON.parse(options.body), reply = await response.clone().json();
      assert.equal(reply.log_id, logId); assert.equal(reply.data.operation, body.operation);
      context.report.jobs.push({ case_id: context.report.stage, job_id: reply.data.id,
        operation: body.operation, input: body.input, submit_log_id: logId,
        expected_status: 'succeeded', transport: 'frontend-factory' });
    }
    return response;
  };
  const client = createApiClient({ baseUrl: context.host.client.base, transport });
  const performance = createHttpPerformance(client, { pollIntervalMs: 10 });
  const runtime = createFrontendRuntime({ baseUrl: context.host.client.base, transport, panelTarget: () => null });
  assert.ok(runtime.performance);
  assert.ok(runtime.extensions.catalog().services.some(entry => entry.id === 'host.performance' && entry.version === '1'));
  const service = async (action, input, signal) => {
    const response = await runtime.host.extensions.callService('host.performance', '1',
      { action, ...(input === undefined ? {} : { input }) }, signal);
    assert.ok(context.host.client.logIds.has(response.logId));
    return response.data;
  };
  return { performance, runtime, service,
    createHistory: () => createHttpPerformance(client, { pollIntervalMs: 10 }),
    dispose: async () => { performance.dispose(); await runtime.dispose(); } };
}
