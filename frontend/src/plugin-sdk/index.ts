import type { Dispose, HostResult, Job, JsonValue, Operation } from './models.ts';
import type { DeviceAccess } from './devices.ts';
import type { ArtifactAccess } from './artifacts.ts';
import type { TaskHistoryAccess } from './task-history.ts';
import type { ThemeAccess, ThemeContribution } from './themes.ts';
import type { ConfigurationAccess, ConfigurationDefinition } from './configuration.ts';
import type { ServiceAccess as ScopedServiceAccess } from './services.ts';
export type { ServiceRef, ServiceContract, ServiceDirectoryEntry, ServerServiceAccess, TypedService, ServiceFeatureDiagnostic } from './services.ts';
export type ServiceAccess = ScopedServiceAccess<HostContext>;
export * from './models.ts';
export * from './slots.ts';
export { hostUi } from './ui.ts';
export type * from './ui.ts';
export type * from './devices.ts';
export type * from './artifacts.ts';
export type * from './task-history.ts';
export type * from './themes.ts';
export type * from './configuration.ts';
export interface HostContext {
  readonly apiVersion: 2;
  readonly signal: AbortSignal;
  readonly listOperations: (signal: AbortSignal) => Promise<HostResult<readonly Operation[]>>;
  readonly submit: (
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
  ) => Promise<HostResult<Job>>;
  readonly getJob: (id: string, signal: AbortSignal) => Promise<HostResult<Job>>;
  readonly cancelJob: (id: string, signal: AbortSignal) => Promise<HostResult<Job>>;
  readonly subscribeOperations: (listener: (operations: readonly Operation[]) => void) => Dispose;
  // 用于事件、定时器及插件自有资源；插件必须登记可释放资源。
  readonly onDispose: (dispose: Dispose) => Dispose;
  readonly extensions?: ExtensionAccess;
  readonly devices?: DeviceAccess;
  readonly artifacts?: ArtifactAccess;
  readonly taskHistory?: TaskHistoryAccess;
  readonly themes?: ThemeAccess;
  readonly configuration?: ConfigurationAccess;
  readonly services?: ServiceAccess;
}
export interface PanelContribution {
  readonly id: string;
  readonly title: string;
  readonly mount: (target: HTMLElement, context: HostContext) => Promise<Dispose>;
}
export interface WebPlugin {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 2;
  readonly panels: readonly PanelContribution[];
  readonly configuration?: ConfigurationDefinition;
  readonly activate?: (context: HostContext) => Promise<void>;
  readonly deactivate?: Dispose;
  readonly contributions?: PluginContributions;
}

export interface TaskSubmission {
  readonly operation: string;
  readonly input: JsonValue;
}
export interface ComponentContribution {
  readonly id: string;
  readonly title: string;
  readonly slot: string;
  readonly mode?: 'append' | 'replace';
  readonly mount: PanelContribution['mount'];
}
export interface ModuleContribution {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly mount: PanelContribution['mount'];
}
export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly execute: (
    input: JsonValue,
    context: HostContext,
    signal: AbortSignal,
  ) => Promise<HostResult<JsonValue>>;
}
export interface ServiceContribution {
  readonly id: string;
  readonly version: string;
  readonly invoke: CommandContribution['execute'];
  readonly inputSchema?: JsonValue;
  readonly outputSchema?: JsonValue;
}
export interface BeforeTaskSubmitHook {
  readonly id: string;
  readonly priority?: number;
  readonly transform: (
    submission: TaskSubmission,
    context: HostContext,
    signal: AbortSignal,
  ) => Promise<TaskSubmission>;
}
export interface PluginContributions {
  readonly themes?: readonly ThemeContribution[];
  readonly components?: readonly ComponentContribution[];
  readonly modules?: readonly ModuleContribution[];
  readonly commands?: readonly CommandContribution[];
  readonly services?: readonly ServiceContribution[];
  readonly beforeTaskSubmit?: readonly BeforeTaskSubmitHook[];
}
export interface ContributionInfo {
  readonly id: string;
  readonly pluginId: string;
  readonly generation: number;
}
export interface ComponentInfo extends ContributionInfo {
  readonly title: string;
  readonly slot: string;
  readonly mode: 'append' | 'replace';
}
export interface ModuleInfo extends ContributionInfo {
  readonly title: string;
  readonly route: string;
}
export interface CommandInfo extends ContributionInfo {
  readonly title: string;
}
export interface ServiceInfo extends ContributionInfo {
  readonly version: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema: JsonValue;
  readonly available: boolean;
  readonly reason: string | null;
}
export interface ExtensionCatalog {
  readonly components: readonly ComponentInfo[];
  readonly modules: readonly ModuleInfo[];
  readonly commands: readonly CommandInfo[];
  readonly services: readonly ServiceInfo[];
}
export interface HostEvent {
  readonly name: string;
  readonly data: JsonValue;
  readonly pluginId: string;
  readonly generation: number;
}
export interface ExtensionAccess {
  readonly catalog: () => ExtensionCatalog;
  readonly executeCommand: (
    id: string,
    input: JsonValue,
    signal: AbortSignal,
  ) => Promise<HostResult<JsonValue>>;
  readonly callService: (
    id: string,
    version: string,
    input: JsonValue,
    signal: AbortSignal,
  ) => Promise<HostResult<JsonValue>>;
  readonly subscribeEvent: (name: string, listener: (event: HostEvent) => void) => Dispose;
  // 插件只能发射自身命名空间事件；宿主可发射 host.* 事件。
  readonly emitEvent: (name: string, data: JsonValue) => void;
  readonly getState: (key: string) => JsonValue | undefined;
  readonly setState: (key: string, value: JsonValue) => void;
  readonly subscribeState: (key: string, listener: (value: JsonValue) => void) => Dispose;
  // 宿主根上下文只消费贡献；插件专属上下文另提供动态注册。
  readonly register?: (contributions: PluginContributions) => Dispose;
}
export interface InstalledWebPackage {
  readonly id: string;
  readonly version: string;
  readonly entryPath: string;
}
export interface WebPluginRuntimeInfo {
  readonly id: string;
  readonly generation: number;
  readonly state: 'loading' | 'loaded';
}
export type EsmImporter = (url: string, signal: AbortSignal) => Promise<unknown>;
export type PackageEntryResolver = (descriptor: InstalledWebPackage, runId: string) => string;
export type SlotMode = 'append' | 'replace';
export interface SlotRequest {
  readonly slot: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly componentId: string;
  readonly mode: SlotMode;
}
export interface SlotLease {
  readonly target: HTMLElement;
  readonly dispose: Dispose;
}
export interface SlotAdapter {
  readonly acquire: (request: SlotRequest, signal: AbortSignal) => Promise<SlotLease>;
}
export interface SlotDefinition {
  readonly id: string;
  readonly target: HTMLElement;
  // 省略即「纯挂载点」：宿主自己渲染默认内容，槽位不接管默认根。
  readonly renderDefault?: (target: HTMLElement) => Dispose | Promise<Dispose>;
  // 省略等价于两种模式都允许；宿主用它在装配处落实保护名单。
  readonly modes?: readonly SlotMode[];
}
// 宿主侧的晚注册入口；React 只在拿到真实 DOM 后才知道挂载点。
export interface SlotHost {
  readonly define: (definition: SlotDefinition) => Promise<Dispose>;
}
