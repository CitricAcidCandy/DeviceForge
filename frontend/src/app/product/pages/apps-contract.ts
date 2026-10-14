import { ApiError } from '../../../shared/api/index.ts';
import type { OperationDto } from '../../../shared/api/index.ts';
import { createJobRunner, jsonObject } from '../../../shared/jobs/index.ts';
import type { JsonData } from '../../../shared/jobs/index.ts';
import type { DeviceAction, DeviceCapability, DeviceProviderInfo, DeviceRef, DeviceSnapshot } from '../../../plugin-sdk/index.ts';
import type { ProductServices } from '../services.ts';

export type AppCapability = 'packages' | 'app.start' | 'app.stop' | 'app.uninstall' | 'app.detail' | 'app.reset' | 'app.install' | 'app.install_apks' | 'connect' | 'disconnect';
export interface CapabilityGate {
  readonly capability: DeviceCapability | null;
  readonly fields: Readonly<Record<string, unknown>> | null;
  readonly reason: string | null;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sameDevice = (left: DeviceRef | null, right: DeviceRef | null): boolean => left === null || right === null ? left === right
  : left.providerId === right.providerId && left.generation === right.generation && left.localId === right.localId;
export const deviceKey = (reference: DeviceRef | null): string => reference ? JSON.stringify([reference.providerId, reference.generation, reference.localId]) : '';
const denied = (reason: string): CapabilityGate => ({capability: null, fields: null, reason});

// 只消费已知的能力第 1 版与业务封套；平台名称不参与入口判断。
export function capabilityGate(snapshot: DeviceSnapshot, operations: readonly OperationDto[], id: AppCapability,
  provider: DeviceProviderInfo | null = null, reference: DeviceRef | null = snapshot.selection): CapabilityGate {
  const scope = id === 'connect' || id === 'disconnect' ? 'provider' : 'device';
  const target = scope === 'provider' ? provider : snapshot.providers.find(item => reference !== null && item.id === reference.providerId && item.generation === reference.generation);
  if (!target || !snapshot.providers.some(item => item.id === target.id && item.generation === target.generation)) return denied('提供者未加载或运行代次已撤销');
  const declaration = target.definition.capabilities.find(item => item.id === id && item.version === 1 && item.scope === scope);
  if (!declaration) return denied(`提供者未声明 ${id}@1 ${scope === 'device' ? '设备' : '提供者'}能力`);
  const expectedAccess = id === 'packages' || id === 'app.detail' ? 'read' : 'write';
  if (declaration.access !== expectedAccess) return denied('能力访问声明与当前动作不兼容');
  if (scope === 'device') {
    if (!reference || !sameDevice(snapshot.selection, reference) || !sameDevice(snapshot.selected?.reference ?? null, reference)) return denied('尚未选择当前代次的设备');
    if (snapshot.selected?.state !== 'online') return denied('设备离线或尚未授权');
    const availability = snapshot.selected.capabilities.find(item => item.id === id && item.version === 1);
    if (!availability?.available) return denied(availability?.reason || `${id}@1 当前不可用`);
  }
  const operation = operations.find(item => item.id === declaration.operation);
  if (!operation) return denied('实际操作尚未进入服务器目录，请刷新能力目录');
  const schema = operation.input_schema;
  if (!record(schema) || !record(schema['properties']) || !record(schema['properties']['input'])) return denied('操作没有兼容的业务输入封套');
  const input = schema['properties']['input'];
  if (input['type'] !== 'object' || !record(input['properties']) || !Array.isArray(input['required']) || !input['required'].every(item => typeof item === 'string')) return denied('业务输入结构未识别');
  const fields = input['properties']; const required: unknown[] = input['required'];
  let allowed: readonly string[]; let necessary: readonly string[];
  if (id === 'packages') { allowed = []; necessary = []; }
  else if (scope === 'provider') { allowed = ['address']; necessary = ['address']; }
  else if (id === 'app.install' || id === 'app.install_apks') { allowed = id === 'app.install_apks' ? ['artifact_id', 'modules'] : ['artifact_id']; necessary = ['artifact_id']; }
  else {
    const identifiers = ['package', 'bundle'].filter(key => key in fields);
    if (identifiers.length !== 1) return denied('应用标识字段未识别或同时声明了 package 与 bundle');
    const key = identifiers[0]; if (!key) return denied('应用标识字段缺失');
    allowed = id === 'app.start' ? [key, 'ability'] : [key]; necessary = [key];
  }
  if (Object.keys(fields).some(key => !allowed.includes(key)) || required.some(key => typeof key !== 'string' || !allowed.includes(key))
    || necessary.some(key => !required.includes(key))) return denied('业务输入包含当前表单未支持的字段或必填约束');
  for (const key of necessary) {
    const field = fields[key];
    if (!record(field) || field['type'] !== 'string') return denied(`字段 ${key} 没有兼容的字符串约束`);
  }
  if ('ability' in fields && (required.includes('ability') || !record(fields['ability']) || fields['ability']['type'] !== 'string')) return denied('当前表单只支持可选的字符串 ability');
  if ('modules' in fields) {
    const modules = fields['modules'];
    if (required.includes('modules') || !record(modules) || !record(modules['items']) || modules['items']['type'] !== 'string'
      || !(modules['type'] === 'array' || Array.isArray(modules['type']) && modules['type'].includes('array') && modules['type'].every(type => type === 'array' || type === 'null'))) return denied('当前表单只支持可选的字符串模块列表');
  }
  return {capability: declaration, fields, reason: null};
}

export function appIdentifierInput(gate: CapabilityGate, identifier: string, ability = ''): {[key: string]: JsonData} {
  if (!gate.capability || !gate.fields) throw new ApiError('protocol', 'unsupported_app_input', gate.reason || '应用动作不可用');
  const key = 'package' in gate.fields ? 'package' : 'bundle';
  return {[key]: identifier, ...('ability' in gate.fields && ability.trim() ? {ability: ability.trim()} : {})};
}
export interface AppList { readonly identifiers: readonly string[]; readonly output: string; readonly unrecognized: readonly string[] }
export interface DeviceBusinessResult { readonly result: JsonData; readonly artifacts: readonly JsonData[] }
export function decodeDeviceBusinessResult(value: unknown, logId: string | null): DeviceBusinessResult {
  if (!jsonObject(value) || !('result' in value) || !Array.isArray(value['artifacts'])) throw new ApiError('protocol', 'invalid_device_business_result', '设备任务没有兼容的业务结果封套', null, logId);
  const result = value['result']; if (result === undefined) throw new ApiError('protocol', 'invalid_device_business_result', '设备任务缺少业务结果', null, logId);
  return {result, artifacts: value['artifacts']};
}
export function decodeAppList(value: unknown, logId: string | null): AppList {
  const business = decodeDeviceBusinessResult(value, logId).result;
  if (!jsonObject(business) || typeof business['output'] !== 'string') throw new ApiError('protocol', 'invalid_apps_result', '应用列表没有兼容的文本结果', null, logId);
  const output = business['output']; const identifiers: string[] = []; const unrecognized: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const identifier = line.startsWith('package:') ? line.slice(8) : line;
    if (/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(identifier)) identifiers.push(identifier);
    else unrecognized.push(line);
  }
  // 混入诊断或未知行时不提供可操作的部分清单，避免将诊断词当成应用。
  return {identifiers: unrecognized.length ? [] : [...new Set(identifiers)], output, unrecognized};
}

// 设备提交与后续任务等待共用同一撤销边界，目录换代或切换选择立即结束旧等待。
export async function executeDeviceTask<T>(services: ProductServices, id: AppCapability,
  action: DeviceAction, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T) {
  const devices = services.runtime.devices; const operations = services.runtime.operations;
  const revoked = new AbortController(); const current = AbortSignal.any([signal, revoked.signal]);
  const reference: DeviceRef | null = action.deviceId === null ? null : {providerId: action.providerId, generation: action.generation, localId: action.deviceId};
  const initial = () => {
    const state = devices.snapshot(); const catalog = operations.snapshot();
    const provider = state.providers.find(item => item.id === action.providerId && item.generation === action.generation) ?? null;
    return capabilityGate(state, catalog.pending ? [] : catalog.result?.data ?? [], id, provider, reference);
  };
  const gate = initial(); const declaration = gate.capability;
  if (!declaration || declaration.id !== action.capability || declaration.version !== action.version) throw new ApiError('protocol', 'device_action_unavailable', gate.reason || '设备能力不可用');
  const signature = JSON.stringify(gate.fields);
  const validate = () => {
    const next = initial();
    if (!next.capability || next.capability.operation !== declaration.operation || JSON.stringify(next.fields) !== signature) revoked.abort();
  };
  const unwatchDevice = devices.subscribe(validate); const unwatchOperations = operations.subscribe(validate);
  const runner = createJobRunner({
    submit: (_operation, _input, requestSignal) => devices.invoke(action, requestSignal),
    getJob: services.runtime.tasks.get, cancelJob: services.runtime.tasks.cancel,
  });
  try {
    validate();
    const result = await runner.execute(declaration.operation, action.input, current, decode);
    validate();
    if (current.aborted) throw new ApiError('cancelled', 'stale_device_result', '设备选择、能力或提供者代次已撤销，旧结果未写入页面', null, result.logId);
    return result;
  } finally { runner.dispose(); unwatchDevice(); unwatchOperations(); }
}

export function deviceAction(reference: DeviceRef, gate: CapabilityGate, input: {[key: string]: JsonData}): DeviceAction {
  if (!gate.capability) throw new ApiError('protocol', 'device_action_unavailable', gate.reason || '设备能力不可用');
  return {providerId: reference.providerId, generation: reference.generation, deviceId: reference.localId,
    capability: gate.capability.id, version: gate.capability.version, input};
}
