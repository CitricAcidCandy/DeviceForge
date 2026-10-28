import { HostError } from '../../../plugin-sdk/index.ts';
import type {
  DeviceAction,
  DeviceDirectory,
  DeviceProviderInfo,
  DeviceRef,
  DeviceSnapshot,
  ProvidedDevice,
} from '../../../plugin-sdk/index.ts';
import { isJsonValue } from '../../../plugin-sdk/json.ts';

function invalid(code: string, message: string, status: number): never {
  throw new HostError('protocol', code, message, null, status);
}
export function sameReference(left: DeviceRef | null, right: DeviceRef | null): boolean {
  return left === null || right === null
    ? left === right
    : left.providerId === right.providerId &&
        left.generation === right.generation &&
        left.localId === right.localId;
}
export function requireProvider(
  providers: readonly DeviceProviderInfo[],
  id: string,
  generation: string,
): DeviceProviderInfo {
  const provider = providers.find((item) => item.id === id);
  if (!provider) return invalid('not_found', '设备插件尚未启用或已被移除，请先启用对应插件', 404);
  if (provider.generation !== generation)
    return invalid('conflict', '设备插件已更新，当前设备信息已过期，请刷新页面后重新选择设备', 409);
  return provider;
}
export function findDevice(
  directories: readonly DeviceDirectory[],
  reference: DeviceRef,
): ProvidedDevice | null {
  return (
    directories
      .find(
        (item) =>
          item.provider.id === reference.providerId &&
          item.provider.generation === reference.generation,
      )
      ?.devices.find((item) => sameReference(item.reference, reference)) ?? null
  );
}
export function requireDevice(
  directories: readonly DeviceDirectory[],
  reference: DeviceRef,
): ProvidedDevice {
  const directory = directories.find(
    (item) =>
      item.provider.id === reference.providerId &&
      item.provider.generation === reference.generation,
  );
  if (!directory) return invalid('conflict', '尚未获取此插件的设备列表，请先重新获取设备列表', 409);
  const device = findDevice([directory], reference);
  if (!device) return invalid('not_found', '设备已不在最新列表中，请重新获取设备列表后选择设备', 404);
  return device;
}
export function validateAction(snapshot: DeviceSnapshot, action: DeviceAction): void {
  if (
    !action.providerId ||
    !action.generation ||
    !action.capability ||
    !Number.isSafeInteger(action.version) ||
    action.version <= 0 ||
    action.input === null ||
    Array.isArray(action.input) ||
    typeof action.input !== 'object' ||
    !isJsonValue(action.input)
  ) {
    invalid('invalid_input', '设备动作需有效身份、精确能力版本与 JSON 对象输入', 400);
  }
  const provider = requireProvider(snapshot.providers, action.providerId, action.generation);
  const capability = provider.definition.capabilities.find(
    (item) => item.id === action.capability && item.version === action.version,
  );
  if (!capability) invalid('not_found', '当前设备插件不支持这项功能或所需版本，请检查插件是否已更新', 404);
  if (capability.scope === 'provider') {
    if (action.deviceId !== null) invalid('invalid_input', '这项功能针对整个设备插件，不能指定单台设备', 400);
    return;
  }
  if (!action.deviceId) invalid('invalid_input', '请先选择要操作的设备', 400);
  const device = requireDevice(snapshot.directories, {
    providerId: action.providerId,
    generation: action.generation,
    localId: action.deviceId,
  });
  if (device.state !== 'online') invalid('conflict', device.state === 'unauthorized'
    ? '设备尚未授权，请在设备上确认连接授权'
    : device.state === 'offline'
      ? '设备已离线，请检查连接后重新获取设备列表'
      : '设备当前不在可操作状态，请检查设备状态后重新连接', 409);
  const availability = device.capabilities.find(
    (item) => item.id === action.capability && item.version === action.version,
  );
  if (!availability?.available)
    invalid('conflict', availability?.reason || '当前设备无法使用这项功能，请检查设备是否满足功能要求', 409);
}
