import type { DeviceAccess, DeviceRef, Dispose, HostContext, HostResult, Operation } from '@deviceforge/plugin-sdk';
import type { JobGateway } from "./jobs/index.js";
export interface OperationSnapshot {
    readonly pending: boolean;
    readonly result: HostResult<readonly Operation[]> | null;
    readonly error: unknown;
}
export interface OperationSource {
    snapshot(): OperationSnapshot;
    subscribe(listener: (snapshot: OperationSnapshot) => void): Dispose;
    list(signal: AbortSignal): Promise<HostResult<readonly Operation[]>>;
    dispose(): void;
}
export declare function createOperationSource(context: HostContext): OperationSource;
export declare function createPublicGateway(context: HostContext): JobGateway;
export interface DeviceConsumer {
    readonly context: HostContext;
    readonly devices: DeviceAccess;
}
/** 始终绑定完整设备引用和能力观测，页面本地 ID 不单独作为归属证明。 */
export declare function withSelectedDevice<T>(services: DeviceConsumer, signal: AbortSignal, run: (reference: DeviceRef, current: AbortSignal) => Promise<T>): Promise<T>;
