import type { DeviceDirectoryDto, DeviceProviderDto } from '../src/services/api/index.ts';

export function provider(id = 'example', generation = 'g1'): DeviceProviderDto {
  return {
    id,
    generation,
    version: '1.0',
    definition: {
      api_version: 1,
      platform: '模拟平台',
      discover_operation: `${id}.discover`,
      capabilities: [
        { id: 'read', version: 1, operation: `${id}.read`, scope: 'device', access: 'read' },
        { id: 'manage', version: 1, operation: `${id}.manage`, scope: 'provider', access: 'write' },
      ],
    },
  };
}
export function directory(
  id = 'example',
  generation = 'g1',
  localIds = ['same'],
): DeviceDirectoryDto {
  return {
    provider: provider(id, generation),
    observed_at: 1,
    discovery_job_id: 'discovery-job',
    devices: localIds.map((local_id) => ({
      reference: { provider_id: id, generation, local_id },
      state: 'online',
      model: null,
      capabilities: [{ id: 'read', version: 1, available: true, reason: null }],
    })),
  };
}
