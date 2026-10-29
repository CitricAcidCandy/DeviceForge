import type { HostContext } from '@deviceforge/plugin-sdk';
import {
  createFileBrowser, FileError, metadataFromWire, entriesFromWire,
} from './model/index.ts';

export function createPublicFileBrowser(context: HostContext) {
  const transport = context.transport;
  const artifacts = context.artifacts;
  const request = async (path: string, method: 'GET' | 'DELETE', signal: AbortSignal) => {
    if (!transport)
      throw new FileError('protocol', 'transport_unavailable', '宿主未提供公开通信能力');
    return transport.request({ path, method }, signal);
  };
  const browser = createFileBrowser({
    async metadata(id, signal) {
      const result = await request(`/api/v2/artifacts/${encodeURIComponent(id)}`, 'GET', signal);
      return { data: metadataFromWire(result.data), logId: result.logId };
    },
    async entries(id, query, signal) {
      const params = new URLSearchParams();
      if (query.offset !== undefined) params.set('offset', String(query.offset));
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const result = await request(`/api/v2/artifacts/${encodeURIComponent(id)}/entries?${params}`, 'GET', signal);
      return { data: entriesFromWire(result.data), logId: result.logId };
    },
    async remove(id, signal) {
      const result = await request(`/api/v2/artifacts/${encodeURIComponent(id)}`, 'DELETE', signal);
      return { data: metadataFromWire(result.data), logId: result.logId };
    },
    ...(artifacts ? {
      upload: (filename: string, content: Blob, signal: AbortSignal) =>
        artifacts.upload(filename, content, signal),
      download: (id: string, signal: AbortSignal) => artifacts.download(id, signal),
    } : {}),
  });
  context.onDispose(browser.dispose);
  return browser;
}
