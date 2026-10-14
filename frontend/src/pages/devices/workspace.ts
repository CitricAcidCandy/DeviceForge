import { ApiError } from '../../services/api/index.ts';
import type { OperationDto } from '../../services/api/index.ts';
import { createJobRunner, jsonObject, requireJson } from '../../shared/jobs/index.ts';
import type { JsonData } from '../../shared/jobs/index.ts';
import type {
  DeviceAccess,
  DeviceCapability,
  DeviceProviderInfo,
  DeviceRef,
  DeviceSnapshot,
} from '../../plugin-sdk/index.ts';
import { deviceKey, sameDevice } from '../../features/device-apps/index.ts';
import type { DeviceTaskServices } from '../../features/device-apps/index.ts';

export { deviceKey, sameDevice };
export const providerKey = (provider: DeviceProviderInfo): string =>
  JSON.stringify([provider.id, provider.generation]);
export const deviceStates = {
  online: '在线',
  offline: '离线',
  unauthorized: '等待设备授权',
  unknown: '状态未知',
};

export function capabilityReason(
  snapshot: DeviceSnapshot,
  operations: readonly OperationDto[],
  reference: DeviceRef,
  capability: DeviceCapability,
): string | null {
  const provider = snapshot.providers.find(
    (item) => item.id === reference.providerId && item.generation === reference.generation,
  );
  const declaration = provider?.definition.capabilities.find(
    (item) => item.id === capability.id && item.version === capability.version,
  );
  if (
    !declaration ||
    declaration.operation !== capability.operation ||
    declaration.scope !== 'device' ||
    declaration.access !== capability.access
  )
    return '提供者或能力版本已变化，请重新读取目录';
  if (
    !sameDevice(snapshot.selection, reference) ||
    !sameDevice(snapshot.selected?.reference ?? null, reference)
  )
    return '当前工作设备已变化';
  if (snapshot.selected?.state !== 'online') return '设备离线或尚未授权';
  const availability = snapshot.selected.capabilities.find(
    (item) => item.id === capability.id && item.version === capability.version,
  );
  if (!availability?.available) return availability?.reason || '此版本能力当前不可用';
  if (!operations.some((item) => item.id === capability.operation))
    return '实际操作尚未进入服务器目录，请刷新能力目录';
  return null;
}

export function parseCapabilityInput(text: string): { [key: string]: JsonData } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError('protocol', 'invalid_device_input', '请填写有效的 JSON 对象');
  }
  if (!jsonObject(value))
    throw new ApiError('protocol', 'invalid_device_input', '设备业务输入必须是 JSON 对象');
  return value;
}

// 全量发现按提供者串行，避免超过服务器发现队列；单个失败不吞掉其他提供者。
export async function discoverProviders(devices: DeviceAccess, signal: AbortSignal) {
  const listed = await devices.refreshProviders(signal);
  const failures: { provider: string; message: string; logId: string | null }[] = [];
  let discovered = 0;
  let logId = listed.logId;
  for (const provider of listed.data) {
    if (signal.aborted)
      throw new ApiError('cancelled', 'cancelled', '设备发现等待已取消', null, logId);
    try {
      const result = await devices.refreshProvider(provider.id, provider.generation, signal);
      discovered += 1;
      logId = result.logId ?? logId;
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push({
        provider: provider.id,
        message: error instanceof Error ? error.message : '发现失败，请重新查询',
        logId:
          error !== null &&
          typeof error === 'object' &&
          'logId' in error &&
          typeof error.logId === 'string'
            ? error.logId
            : null,
      });
    }
  }
  return { data: { discovered, failures }, logId };
}

// 离散动作接纳后继续查询终态；选择、声明或输入模式换代会撤销旧任务等待。
export async function executeCapability(
  services: DeviceTaskServices,
  reference: DeviceRef,
  capability: DeviceCapability,
  input: { [key: string]: JsonData },
  signal: AbortSignal,
) {
  const revoked = new AbortController();
  const current = AbortSignal.any([signal, revoked.signal]);
  const catalog = () => services.runtime.operations.snapshot();
  const operations = () => (catalog().pending ? [] : (catalog().result?.data ?? []));
  const initialSchema = JSON.stringify(
    operations().find((item) => item.id === capability.operation)?.input_schema,
  );
  const reason = () =>
    capabilityReason(services.runtime.devices.snapshot(), operations(), reference, capability);
  const unavailable = reason();
  if (unavailable) throw new ApiError('protocol', 'device_capability_unavailable', unavailable);
  const validate = () => {
    if (
      reason() ||
      JSON.stringify(
        operations().find((item) => item.id === capability.operation)?.input_schema,
      ) !== initialSchema
    )
      revoked.abort();
  };
  const unwatchDevices = services.runtime.devices.subscribe(validate);
  const unwatchOperations = services.runtime.operations.subscribe(validate);
  const runner = createJobRunner({
    submit: (_operation, _input, requestSignal) =>
      services.runtime.devices.invoke(
        {
          providerId: reference.providerId,
          generation: reference.generation,
          deviceId: reference.localId,
          capability: capability.id,
          version: capability.version,
          input,
        },
        requestSignal,
      ),
    getJob: services.runtime.tasks.get,
    cancelJob: services.runtime.tasks.cancel,
  });
  try {
    validate();
    const result = await runner.execute(capability.operation, input, current, requireJson);
    validate();
    if (current.aborted)
      throw new ApiError(
        'cancelled',
        'stale_device_result',
        '当前设备或能力已撤销，旧结果未写入页面',
        null,
        result.logId,
      );
    return result;
  } finally {
    runner.dispose();
    unwatchDevices();
    unwatchOperations();
  }
}
