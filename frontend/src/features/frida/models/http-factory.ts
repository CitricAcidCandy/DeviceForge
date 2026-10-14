import type { ArtifactAccess } from '../../../plugin-sdk/index.ts';
import { operationsEndpoint, uploadEndpoint } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import { createHttpJobGateway } from '../../../shared/jobs/index.ts';
import type { FridaOptions } from '../types/index.ts';
import { createFrida } from './frida.ts';

export function createHttpFrida(client: ApiClient, options: Omit<FridaOptions, 'operations'> = {}) {
  const artifacts: ArtifactAccess = {
    async upload(filename, content, signal) {
      const response = await client.call(uploadEndpoint, { filename, content }, signal);
      const artifact = response.data;
      return {
        data: {
          id: artifact.id,
          filename: artifact.filename,
          mediaType: artifact.media_type,
          size: artifact.size,
          sha256: artifact.sha256,
          createdAt: artifact.created_at,
        },
        logId: response.logId,
      };
    },
    download: (id, signal) => client.downloadArtifact(id, signal),
  };
  return createFrida(createHttpJobGateway(client), artifacts, {
    ...options,
    operations: { list: (signal) => client.call(operationsEndpoint, undefined, signal) },
  });
}
