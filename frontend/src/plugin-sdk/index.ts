export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Operation { readonly id: string; readonly title: string; readonly input_schema: Readonly<Record<string, JsonValue>> }
export interface Job { readonly id: string; readonly operation: string; readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; readonly result: JsonValue; readonly error: string | null }
export interface HostContext {
  readonly apiVersion: 1;
  readonly listOperations: (signal?: AbortSignal) => Promise<readonly Operation[]>;
  readonly submit: (operation: string, input: JsonValue, signal?: AbortSignal) => Promise<Job>;
  readonly getJob: (id: string, signal?: AbortSignal) => Promise<Job>;
  readonly cancelJob: (id: string, signal?: AbortSignal) => Promise<Job>;
}
export interface PanelContribution {
  readonly id: string;
  readonly title: string;
  readonly mount: (target: HTMLElement, context: HostContext) => Promise<() => void>;
}
export interface WebPlugin {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly panels: readonly PanelContribution[];
  readonly activate?: (context: HostContext) => Promise<void>;
  readonly deactivate?: () => Promise<void>;
}
