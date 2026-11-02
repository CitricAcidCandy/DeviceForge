import type { DeviceAction, DeviceCapability, DeviceProviderInfo, DeviceRef, DeviceSnapshot, Operation } from '@deviceforge/plugin-sdk';
import { jsonObject } from '@deviceforge/business-kit/jobs';
import type { JsonData } from '@deviceforge/business-kit/jobs';
import { capabilityGate } from '@deviceforge/business-kit/device';
import { sameDevice } from './contracts.ts';

export interface DeviceActionRequest {
  readonly provider: DeviceProviderInfo;
  readonly capability: DeviceCapability;
  readonly reference: DeviceRef | null;
  readonly input: { readonly [key: string]: JsonData };
}
export function parseDeviceInput(text: string): { [key: string]: JsonData } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('请填写有效的 JSON 对象'); }
  if (!jsonObject(value)) throw new Error('设备业务输入必须是有限、无循环的 JSON 对象');
  return value;
}
export function deviceActionReason(
  snapshot: DeviceSnapshot, operations: readonly Operation[], request: DeviceActionRequest,
): string | null {
  const { provider, capability, reference } = request;
  const current = snapshot.providers.find((entry) => entry.id === provider.id && entry.generation === provider.generation);
  const declared = current?.definition.capabilities.find((entry) => entry.id === capability.id &&
    entry.version === capability.version && entry.scope === capability.scope &&
    entry.access === capability.access && entry.operation === capability.operation);
  if (!declared) return '提供者或能力声明已变化，请重新读取目录';
  if (capability.scope === 'provider') {
    if (reference) return '提供者动作不应携带设备目标';
    if (capability.id === 'connect' || capability.id === 'disconnect') {
      const gate = capabilityGate(snapshot, operations, capability.id, current);
      if (!gate.capability || gate.capability.version !== capability.version) return gate.reason ?? '连接能力版本不兼容';
    }
  } else {
    if (!reference || reference.providerId !== provider.id || reference.generation !== provider.generation ||
        !sameDevice(snapshot.selection, reference) || !sameDevice(snapshot.selected?.reference ?? null, reference))
      return '当前工作设备已变化';
    if (snapshot.selected?.state !== 'online') return '设备离线或尚未授权';
    const availability = snapshot.selected.capabilities.find((entry) => entry.id === capability.id && entry.version === capability.version);
    if (!availability?.available) return availability?.reason || '该版本设备能力当前不可用';
  }
  return operations.some((entry) => entry.id === capability.operation)
    ? null : '实际操作尚未进入服务器目录，请刷新能力目录';
}
export function actionInput(request: DeviceActionRequest): DeviceAction {
  return {
    providerId: request.provider.id, generation: request.provider.generation,
    deviceId: request.reference?.localId ?? null, capability: request.capability.id,
    version: request.capability.version, input: request.input,
  };
}
