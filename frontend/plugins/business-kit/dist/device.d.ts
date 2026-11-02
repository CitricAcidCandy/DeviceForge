import type { OperationDto } from "./api/index.js";
import type { JsonData } from "./jobs/index.js";
import type { DeviceAction, DeviceCapability, DeviceProviderInfo, DeviceRef, DeviceSnapshot } from '@deviceforge/plugin-sdk';
import type { DeviceAccess, HostContext } from '@deviceforge/plugin-sdk';
import type { OperationSource } from "./platform.js";
export interface DeviceTaskServices {
    readonly devices: DeviceAccess;
    readonly operations: OperationSource;
    readonly context: Pick<HostContext, 'getJob' | 'cancelJob'>;
}
export type AppCapability = 'packages' | 'app.start' | 'app.stop' | 'app.uninstall' | 'app.detail' | 'app.reset' | 'app.install' | 'app.install_apks' | 'connect' | 'disconnect';
export interface CapabilityGate {
    readonly capability: DeviceCapability | null;
    readonly fields: Readonly<Record<string, unknown>> | null;
    readonly reason: string | null;
}
export declare const sameDevice: (left: DeviceRef | null, right: DeviceRef | null) => boolean;
export declare const deviceKey: (reference: DeviceRef | null) => string;
export declare function capabilityGate(snapshot: DeviceSnapshot, operations: readonly OperationDto[], id: AppCapability, provider?: DeviceProviderInfo | null, reference?: DeviceRef | null): CapabilityGate;
export declare function appIdentifierInput(gate: CapabilityGate, identifier: string, ability?: string): {
    [key: string]: JsonData;
};
export interface AppList {
    readonly identifiers: readonly string[];
    readonly output: string;
    readonly unrecognized: readonly string[];
}
export interface DeviceBusinessResult {
    readonly result: JsonData;
    readonly artifacts: readonly JsonData[];
}
export declare function decodeDeviceBusinessResult(value: unknown, logId: string | null): DeviceBusinessResult;
export declare function decodeAppList(value: unknown, logId: string | null): AppList;
export declare function executeDeviceTask<T>(services: DeviceTaskServices, id: AppCapability, action: DeviceAction, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T): Promise<import("./index.js").JobOutcome<T>>;
export declare function deviceAction(reference: DeviceRef, gate: CapabilityGate, input: {
    [key: string]: JsonData;
}): DeviceAction;
