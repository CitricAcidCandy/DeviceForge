import type { DeviceDirectoryDto, DeviceProviderDto, OperationDto } from '../src/services/api/index.ts';
import { createSessionStreamFixture, fixtureObject, fixtureReply } from './session-fixture-streams.ts';
import { createSessionJobFixture } from './session-fixture-jobs.ts';

export interface SessionFixtureRequest {readonly method: string; readonly path: string; readonly input: unknown}
export async function createSessionFixture() {
  const requests: SessionFixtureRequest[] = []; const streams = createSessionStreamFixture(); const jobs = await createSessionJobFixture();
  const provider: DeviceProviderDto = {id: 'fixture.android', generation: 'fixture-generation', version: '1.0', definition: {api_version: 1, platform: '受控能力来源', discover_operation: 'plugin.android-device.discover', capabilities: []}};
  const directory: DeviceDirectoryDto = {provider, observed_at: 1, discovery_job_id: crypto.randomUUID(), devices: [{reference: {provider_id: provider.id, generation: provider.generation, local_id: 'device-a'}, model: '受控设备', state: 'online', capabilities: []}]};
  const allOperations: OperationDto[] = [
    ...['server.status', 'server.deploy', 'server.run', 'processes', 'script.run', 'permissions.analyze'].map(id => 'plugin.frida.' + id),
    ...['sequence.run', 'click.repeat', 'windows.mouse.position', 'windows.mouse.click', 'windows.mouse.repeat', 'input_trace.record', 'input_trace.playback'].map(id => 'plugin.automation.' + id),
    ...['sdk.single', 'sdk.turn', 'assistant.run', 'runtime.status', 'session.get', 'session.close'].map(id => 'plugin.ai-sdk.' + id),
    ...['cli.single', 'cli.turn', 'runtime.status', 'session.get', 'session.close'].map(id => 'plugin.ai-assistant.' + id),
  ].map(id => ({id, title: id, input_schema: {type: 'object'}}));
  let operations = [...allOperations]; let mcpVersion = 1; let subscription: ReadableStreamDefaultController<Uint8Array> | null = null; let subscriptionCancelled = 0;
  const transport: typeof fetch = async (resource, options) => {
    const url = resource instanceof Request ? new URL(resource.url) : new URL(String(resource)); const method = options?.method ?? 'GET';
    const input: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
    requests.push({method, path: url.pathname + url.search, input});
    if (options?.signal?.aborted) throw new DOMException('受控请求已取消', 'AbortError');
    if (url.pathname === '/api/v2/operations') return fixtureReply(operations);
    if (url.pathname === '/api/v2/device-providers') return fixtureReply([provider]);
    if (url.pathname === '/api/v2/devices') return fixtureReply([directory]);
    if (url.pathname === '/mcp') {
      if (!fixtureObject(input) || typeof input['id'] !== 'number') throw new Error('受控 MCP 请求形状无效');
      if (input['method'] === 'tools/list') return Response.json({jsonrpc: '2.0', id: input['id'], result: {tools: [{name: `fixture.tool.${mcpVersion}`, title: `真实协议工具 ${mcpVersion}`, description: '受控 MCP 目录', inputSchema: {type: 'object'}}]}}, {headers: {'x-deviceforge-log-id': 'session-fixture-log'}});
      if (input['method'] !== 'subscriptions/listen') throw new Error('未列出的受控 MCP 方法');
      return new Response(new ReadableStream<Uint8Array>({start(controller) {
        subscription = controller; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: {notifications: {toolsListChanged: true}}})}\n\n`));
      }, cancel() {subscription = null; subscriptionCancelled++;}}), {headers: {'content-type': 'text/event-stream', 'x-deviceforge-log-id': 'session-fixture-log'}});
    }
    const stream = await streams.handle(url, method, input, options?.signal); if (stream) return stream;
    const job = await jobs.handle(url, method, input, options?.body); if (job) return job;
    throw new Error(`未列出的受控请求：${method} ${url.pathname}`);
  };
  return {transport, requests, provider, streams, recordingId: jobs.recordingId,
    setOperations(ids: readonly string[]) {operations = allOperations.filter(item => ids.includes(item.id));}, restoreOperations() {operations = [...allOperations];},
    notifyMcp() {mcpVersion++; subscription?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {_meta: {'deviceforge/log_id': 'session-fixture-log'}}})}\n\n`));},
    subscriptionCancelled: () => subscriptionCancelled,
    dispose() {streams.dispose(); subscription?.close(); subscription = null;},
  };
}
