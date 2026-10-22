import {
  installationsEndpoint, installationPlanEndpoint, installReleaseEndpoint,
  updateReleaseEndpoint, enableReleaseEndpoint, uninstallReleaseEndpoint, jobEndpoint,
} from '../../../services/api/index.ts';
import type { ApiClient, InstalledReleaseDto, InstallationSourceDto } from '../../../services/api/index.ts';
import type { InstallationGateway, InstallationSource, PluginInstallation } from '../types/index.ts';

function sourceDto(source: InstallationSource): InstallationSourceDto {
  return source.kind === 'offline' ? { kind: 'offline', artifact_id: source.artifactId } : {
    kind: 'market', source_url: source.sourceUrl, release_id: source.releaseId,
    version: source.version, manifest_sha256: source.releaseDigest,
  };
}
function installation(value: InstalledReleaseDto): PluginInstallation {
  return { id: value.id, name: value.name, summary: value.description.split(/\r?\n/, 1)[0] ?? '',
    description: value.description, version: value.version, revision: value.revision,
    enabled: value.enabled, status: value.status,
    components: value.components.map((component) => ({ id: component.id, kind: component.kind,
      version: component.version, revision: component.revision, entryPath: component.entry_path,
      entryUrl: component.entry_url ?? null })) };
}
export function createInstallationGateway(client: ApiClient): InstallationGateway {
  return {
    list: async (signal) => {
      const result = await client.call(installationsEndpoint, undefined, signal);
      return { ...result, data: result.data.map(installation) };
    },
    plan: async (source, signal) => {
      const result = await client.call(installationPlanEndpoint, sourceDto(source), signal);
      return { ...result, data: { id: result.data.id, version: result.data.version, revision: result.data.revision, issues: result.data.issues } };
    },
    install: (source, signal) => client.call(installReleaseEndpoint, { source: sourceDto(source) }, signal),
    update: (id, revision, source, signal) => client.call(updateReleaseEndpoint,
      { id, body: { source: sourceDto(source), expected_revision: revision } }, signal),
    setEnabled: (id, revision, enabled, signal) => client.call(enableReleaseEndpoint,
      { id, body: { expected_revision: revision, enabled } }, signal),
    uninstall: (id, revision, signal) => client.call(uninstallReleaseEndpoint,
      { id, body: { expected_revision: revision } }, signal),
    getJob: (id, signal) => client.call(jobEndpoint, id, signal),
  };
}
