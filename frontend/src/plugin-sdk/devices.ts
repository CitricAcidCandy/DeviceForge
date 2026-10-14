import type { Dispose, HostResult, Job, JsonValue } from './models.ts';

// 这是独立公开 SDK 模型；HTTP snake_case 字段由宿主适配器显式映射。
export interface DeviceCapability {
  readonly id: string;
  readonly version: number;
  readonly operation: string;
  readonly scope: 'provider' | 'device';
  readonly access: 'read' | 'write';
  // 设备声明 API 2/3 可提供；省略由宿主采用 30000 毫秒，浏览器不能覆盖。
  readonly executionTimeoutMs?: number;
}
export interface DeviceProviderDefinition {
  readonly apiVersion: number;
  readonly platform: string;
  readonly discoverOperation: string;
  readonly capabilities: readonly DeviceCapability[];
}
export interface DeviceProviderInfo {
  readonly id: string;
  readonly generation: string;
  readonly version: string;
  readonly definition: DeviceProviderDefinition;
}
export interface DeviceRef {
  readonly providerId: string;
  readonly generation: string;
  readonly localId: string;
}
export interface CapabilityAvailability {
  readonly id: string;
  readonly version: number;
  readonly available: boolean;
  readonly reason: string | null;
}
export interface ProvidedDevice {
  readonly reference: DeviceRef;
  readonly state: 'online' | 'offline' | 'unauthorized' | 'unknown';
  // API 3 的原始观测仅用于说明，不覆盖规范状态或能力准入；None 时省略。
  readonly rawState?: string;
  readonly model: string | null;
  readonly capabilities: readonly CapabilityAvailability[];
}
export interface DeviceDirectory {
  readonly provider: DeviceProviderInfo;
  readonly observedAt: number;
  readonly discoveryJobId: string;
  readonly devices: readonly ProvidedDevice[];
}
export interface DeviceAction {
  readonly providerId: string;
  readonly generation: string;
  readonly deviceId: string | null;
  readonly capability: string;
  readonly version: number;
  readonly input: { readonly [key: string]: JsonValue };
}
export interface DeviceSnapshot {
  readonly providers: readonly DeviceProviderInfo[];
  readonly directories: readonly DeviceDirectory[];
  readonly selection: DeviceRef | null;
  readonly selected: ProvidedDevice | null;
}
export interface DeviceAccess {
  readonly refreshProviders: (
    signal: AbortSignal,
  ) => Promise<HostResult<readonly DeviceProviderInfo[]>>;
  readonly refreshDirectories: (
    signal: AbortSignal,
  ) => Promise<HostResult<readonly DeviceDirectory[]>>;
  readonly refreshProvider: (
    id: string,
    generation: string,
    signal: AbortSignal,
  ) => Promise<HostResult<DeviceDirectory>>;
  readonly select: (reference: DeviceRef | null) => void;
  readonly snapshot: () => DeviceSnapshot;
  readonly subscribe: (listener: (snapshot: DeviceSnapshot) => void) => Dispose;
  readonly invoke: (action: DeviceAction, signal: AbortSignal) => Promise<HostResult<Job>>;
}
