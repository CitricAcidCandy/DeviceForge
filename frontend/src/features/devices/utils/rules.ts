import { HostError } from '../../../plugin-sdk/index.ts';
import type { DeviceAction, DeviceDirectory, DeviceProviderInfo, DeviceRef, DeviceSnapshot, ProvidedDevice } from '../../../plugin-sdk/index.ts';
import { isJsonValue } from '../../../plugin-sdk/json.ts';

function invalid(code: string, message: string, status: number): never {
  throw new HostError('protocol', code, message, null, status);
}
export function sameReference(left: DeviceRef | null, right: DeviceRef | null): boolean {
  return left === null || right === null ? left === right
    : left.providerId === right.providerId && left.generation === right.generation && left.localId === right.localId;
}
export function requireProvider(providers: readonly DeviceProviderInfo[], id: string, generation: string): DeviceProviderInfo {
  const provider = providers.find((item) => item.id === id);
  if (!provider) return invalid('not_found', '设备提供者不存在或已卸载', 404);
  if (provider.generation !== generation) return invalid('conflict', '设备提供者运行代次已变化', 409);
  return provider;
}
export function findDevice(directories: readonly DeviceDirectory[], reference: DeviceRef): ProvidedDevice | null {
  return directories.find((item) => item.provider.id === reference.providerId && item.provider.generation === reference.generation)
    ?.devices.find((item) => sameReference(item.reference, reference)) ?? null;
}
export function requireDevice(directories: readonly DeviceDirectory[], reference: DeviceRef): ProvidedDevice {
  const directory = directories.find((item) => item.provider.id === reference.providerId && item.provider.generation === reference.generation);
  if (!directory) return invalid('conflict', '设备提供者尚无本代观测目录', 409);
  const device = findDevice([directory], reference);
  if (!device) return invalid('not_found', '设备不在当前提供者观测目录中', 404);
  return device;
}
export function validateAction(snapshot: DeviceSnapshot, action: DeviceAction): void {
  if (!action.providerId || !action.generation || !action.capability || !Number.isSafeInteger(action.version) || action.version <= 0
    || action.input === null || Array.isArray(action.input) || typeof action.input !== 'object' || !isJsonValue(action.input)) {
    invalid('invalid_input', '设备动作需有效身份、精确能力版本与 JSON 对象输入', 400);
  }
  const provider = requireProvider(snapshot.providers, action.providerId, action.generation);
  const capability = provider.definition.capabilities.find((item) => item.id === action.capability && item.version === action.version);
  if (!capability) invalid('not_found', '设备能力或请求版本未声明', 404);
  if (capability.scope === 'provider') {
    if (action.deviceId !== null) invalid('invalid_input', '提供者能力不能携带设备身份', 400);
    return;
  }
  if (!action.deviceId) invalid('invalid_input', '设备能力必须携带本地设备身份', 400);
  const device = requireDevice(snapshot.directories, { providerId: action.providerId, generation: action.generation, localId: action.deviceId });
  if (device.state !== 'online') invalid('conflict', '设备不在线或尚未授权', 409);
  const availability = device.capabilities.find((item) => item.id === action.capability && item.version === action.version);
  if (!availability?.available) invalid('conflict', availability?.reason || '设备能力缺失或当前不可用', 409);
}
