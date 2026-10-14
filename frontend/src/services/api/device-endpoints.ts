import type { DeviceActionDto, DeviceDirectoryDto, DeviceProviderDto, Endpoint, JobDto, RefreshDeviceProviderBody, RefreshDeviceProviderPath } from './types.ts';
import { encodedId } from './endpoints.ts';
import { isDeviceDirectory, isDeviceDirectoryList, isDeviceProviderList } from './device-validation.ts';
import { isJob } from './validation.ts';

export const deviceProvidersEndpoint: Endpoint<void, DeviceProviderDto[]> = {
  request: () => ({ path: '/api/v2/device-providers', method: 'GET' }), decode: isDeviceProviderList,
};
export const deviceDirectoriesEndpoint: Endpoint<void, DeviceDirectoryDto[]> = {
  request: () => ({ path: '/api/v2/devices', method: 'GET' }), decode: isDeviceDirectoryList,
};
export const refreshDeviceProviderEndpoint: Endpoint<RefreshDeviceProviderPath & RefreshDeviceProviderBody, DeviceDirectoryDto> = {
  request: ({ id, generation }) => ({ path: `/api/v2/device-providers/${encodedId(id)}/refresh`, method: 'POST', body: JSON.stringify({ generation }), contentType: 'application/json' }),
  decode: isDeviceDirectory,
};
export const deviceActionEndpoint: Endpoint<DeviceActionDto, JobDto> = {
  request: (input) => ({ path: '/api/v2/device-actions', method: 'POST', body: JSON.stringify(input), contentType: 'application/json' }), decode: isJob,
};
