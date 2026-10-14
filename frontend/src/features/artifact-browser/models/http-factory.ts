import {
  artifactDeleteEndpoint,
  artifactEntriesEndpoint,
  artifactMetadataEndpoint,
  uploadEndpoint,
} from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import { createArtifactBrowser } from './artifact-browser.ts';

export function createHttpArtifactBrowser(client: ApiClient) {
  return createArtifactBrowser({
    metadata: (id, signal) => client.call(artifactMetadataEndpoint, { id }, signal),
    entries: (id, query, signal) => client.call(artifactEntriesEndpoint, { id, query }, signal),
    remove: (id, signal) => client.call(artifactDeleteEndpoint, { id }, signal),
    upload: (filename, content, signal) =>
      client.call(uploadEndpoint, { filename, content }, signal),
    download: (id, signal) => client.downloadArtifact(id, signal),
  });
}
