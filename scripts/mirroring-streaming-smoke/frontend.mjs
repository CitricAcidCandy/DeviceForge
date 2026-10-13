import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function actualFrontend(host, report, frontendRoot = fileURLToPath(new URL('../../frontend/', import.meta.url))) {
  const { createApiClient } = await import(pathToFileURL(join(frontendRoot, 'src/shared/api/client.ts')).href);
  const { createHttpMirroringStreaming } = await import(pathToFileURL(join(frontendRoot, 'src/features/mirroring-streaming/index.ts')).href);
  const packets = [], resets = [];
  const client = createApiClient({ baseUrl: host.client.base, transport: async (input, options) => {
    const response = await fetch(input, options), logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, /^[a-f\d-]{36}$/); host.client.logIds.add(logId);
    const url = new URL(input instanceof Request ? input.url : String(input));
    report.requests.push({ client_method: '实际投屏直播前端工厂', path: url.pathname + url.search,
      method: options?.method ?? 'GET', status: response.status, log_id: logId });
    return response;
  } });
  const frontend = createHttpMirroringStreaming(client, { pollIntervalMs: 25, sink: {
    packet(packet, signal) { assert.equal(signal.aborted, false); packets.push(packet); },
    reset() { resets.push({ packet_count: packets.length }); },
  } });
  return { frontend, packets, resets };
}
