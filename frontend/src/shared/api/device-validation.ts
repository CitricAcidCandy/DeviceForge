import type { DeviceDirectoryDto, DeviceProviderDto, DeviceRefDto } from './types.ts';
import { isArrayOf, isRecord } from './validation.ts';

const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const optionalText = (value: unknown) => value === undefined || value === null || typeof value === 'string';
type CapabilityDto = DeviceProviderDto['definition']['capabilities'][number];
type ProvidedDeviceDto = DeviceDirectoryDto['devices'][number];
type AvailabilityDto = ProvidedDeviceDto['capabilities'][number];

function isCapability(value: unknown): value is CapabilityDto {
  return isRecord(value) && text(value.id) && positive(value.version) && text(value.operation)
    && (value.scope === 'provider' || value.scope === 'device') && (value.access === 'read' || value.access === 'write');
}
export function isDeviceProvider(value: unknown): value is DeviceProviderDto {
  if (!isRecord(value) || !text(value.id) || !text(value.generation) || !text(value.version) || !isRecord(value.definition)) return false;
  const definition = value.definition;
  if (definition.api_version !== 1 || !text(definition.platform) || !text(definition.discover_operation)
    || !isArrayOf(isCapability)(definition.capabilities) || definition.capabilities.length > 32) return false;
  return new Set(definition.capabilities.map((item) => `${item.id}:${item.version}`)).size === definition.capabilities.length;
}
export function isDeviceReference(value: unknown): value is DeviceRefDto {
  return isRecord(value) && text(value.provider_id) && text(value.generation) && text(value.local_id);
}
function isAvailability(value: unknown): value is AvailabilityDto {
  return isRecord(value) && text(value.id) && positive(value.version) && typeof value.available === 'boolean' && optionalText(value.reason);
}
function isProvidedDevice(value: unknown): value is ProvidedDeviceDto {
  return isRecord(value) && isDeviceReference(value.reference)
    && (value.state === 'online' || value.state === 'offline' || value.state === 'unauthorized' || value.state === 'unknown')
    && optionalText(value.model) && isArrayOf(isAvailability)(value.capabilities)
    && new Set(value.capabilities.map((item) => `${item.id}:${item.version}`)).size === value.capabilities.length;
}
export function isDeviceDirectory(value: unknown): value is DeviceDirectoryDto {
  if (!isRecord(value) || !isDeviceProvider(value.provider) || typeof value.observed_at !== 'number'
    || !Number.isSafeInteger(value.observed_at) || value.observed_at < 0 || !text(value.discovery_job_id)
    || !isArrayOf(isProvidedDevice)(value.devices) || value.devices.length > 128) return false;
  const provider = value.provider;
  return new Set(value.devices.map((item) => item.reference.local_id)).size === value.devices.length
    && value.devices.every((item) => item.reference.provider_id === provider.id && item.reference.generation === provider.generation
      && item.capabilities.every((available) => provider.definition.capabilities.some((declared) => declared.id === available.id && declared.version === available.version)));
}
export function isDeviceProviderList(value: unknown): value is DeviceProviderDto[] {
  return isArrayOf(isDeviceProvider)(value) && new Set(value.map((item) => item.id)).size === value.length;
}
export function isDeviceDirectoryList(value: unknown): value is DeviceDirectoryDto[] {
  return isArrayOf(isDeviceDirectory)(value) && new Set(value.map((item) => item.provider.id)).size === value.length;
}
