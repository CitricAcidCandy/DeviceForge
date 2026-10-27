import type { Dispose, HostResult, Job, JsonValue } from './models.ts';

export interface ServiceRef {
  readonly id: string;
  readonly version: string;
}
export interface ServiceContract {
  readonly inputSchema: JsonValue;
  readonly outputSchema: JsonValue;
}
export interface ServiceDirectoryEntry {
  readonly service: ServiceRef;
  readonly contract: ServiceContract;
  readonly operation: string | null;
  readonly provider: { readonly id: string; readonly version: string; readonly generation: string };
  readonly available: boolean;
  readonly reason: string | null;
}
export interface ServerServiceAccess {
  list(signal: AbortSignal): Promise<HostResult<readonly ServiceDirectoryEntry[]>>;
  submit(ref: ServiceRef, input: JsonValue, signal: AbortSignal, generation?: string): Promise<HostResult<Job>>;
}
export interface TypedService<I extends JsonValue, O extends JsonValue> extends ServiceRef {
  readonly accepts: (value: unknown) => value is I;
  readonly returns: (value: unknown) => value is O;
}
export interface ServiceFeatureDiagnostic {
  readonly featureId: string;
  readonly state: 'waiting' | 'starting' | 'active' | 'failed' | 'stopped';
  readonly missing: readonly ServiceRef[];
  readonly error: string | null;
  readonly cleanupErrors: readonly { readonly registration: number; readonly revision: number; readonly message: string }[];
}
export interface ServiceAccess<Context> {
  readonly server?: ServerServiceAccess;
  catalog(): readonly ServiceDirectoryEntry[];
  call(ref: ServiceRef, input: JsonValue, signal: AbortSignal): Promise<HostResult<JsonValue>>;
  callTyped<I extends JsonValue, O extends JsonValue>(
    ref: TypedService<I, O>, input: I, signal: AbortSignal,
  ): Promise<HostResult<O>>;
  whenAvailable(
    featureId: string,
    required: readonly ServiceRef[],
    setup: (context: Context) => void | Dispose | Promise<void | Dispose>,
  ): Dispose;
  diagnostics(): readonly ServiceFeatureDiagnostic[];
}
