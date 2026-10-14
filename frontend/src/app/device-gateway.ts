import type { DeviceAction, DeviceCapability, DeviceDirectory, DeviceProviderInfo, DeviceRef } from '../plugin-sdk/index.ts';
import type { DeviceGateway } from '../features/devices/index.ts';
import { deviceActionEndpoint, deviceDirectoriesEndpoint, deviceProvidersEndpoint, refreshDeviceProviderEndpoint } from '../services/api/index.ts';
import type { ApiClient, DeviceActionDto, DeviceDirectoryDto, DeviceProviderDto, DeviceRefDto } from '../services/api/index.ts';
import { publicCall, publicJob } from './public-api.ts';

function capability(dto: DeviceProviderDto['definition']['capabilities'][number]): DeviceCapability {
  return Object.freeze({ id: dto.id, version: dto.version, operation: dto.operation, scope: dto.scope, access: dto.access,
    ...(dto.execution_timeout_ms == null ? {} : { executionTimeoutMs: dto.execution_timeout_ms }),
  });
}
function provider(dto: DeviceProviderDto): DeviceProviderInfo {
  return Object.freeze({ id: dto.id, generation: dto.generation, version: dto.version,
    definition: Object.freeze({ apiVersion: dto.definition.api_version, platform: dto.definition.platform,
      discoverOperation: dto.definition.discover_operation,
      capabilities: Object.freeze(dto.definition.capabilities.map(capability)),
    }),
  });
}
function reference(dto: DeviceRefDto): DeviceRef {
  return Object.freeze({ providerId: dto.provider_id, generation: dto.generation, localId: dto.local_id });
}
function directory(dto: DeviceDirectoryDto): DeviceDirectory {
  return Object.freeze({ provider: provider(dto.provider), observedAt: dto.observed_at, discoveryJobId: dto.discovery_job_id,
    devices: Object.freeze(dto.devices.map((item) => Object.freeze({ reference: reference(item.reference), state: item.state, model: item.model ?? null,
      ...(item.raw_state == null ? {} : { rawState: item.raw_state }),
      capabilities: Object.freeze(item.capabilities.map((value) => Object.freeze({ id: value.id, version: value.version, available: value.available, reason: value.reason ?? null }))),
    }))),
  });
}
function action(input: DeviceAction): DeviceActionDto {
  return { provider_id: input.providerId, generation: input.generation, device_id: input.deviceId, capability: input.capability, version: input.version, input: input.input };
}
export function createDeviceGateway(client: ApiClient, lifetime: AbortSignal): DeviceGateway {
  const signal = (caller: AbortSignal) => AbortSignal.any([caller, lifetime]);
  return {
    refreshProviders: (caller) => publicCall(client.call(deviceProvidersEndpoint, undefined, signal(caller)), (items) => Object.freeze(items.map(provider))),
    refreshDirectories: (caller) => publicCall(client.call(deviceDirectoriesEndpoint, undefined, signal(caller)), (items) => Object.freeze(items.map(directory))),
    refreshProvider: (id, generation, caller) => publicCall(client.call(refreshDeviceProviderEndpoint, { id, generation }, signal(caller)), directory),
    invoke: (input, caller) => publicCall(client.call(deviceActionEndpoint, action(input), signal(caller)), publicJob),
  };
}
