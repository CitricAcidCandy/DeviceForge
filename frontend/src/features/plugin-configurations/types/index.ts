import type { ConfigurationDefinition, JsonValue } from '../../../plugin-sdk/index.ts';

// 页面使用的配置视图，服务器 snake_case 传输模型在适配器中转换。
export interface PluginConfigurationView {
  readonly kind: 'server' | 'browser';
  readonly id: string;
  readonly definition: ConfigurationDefinition | null;
  readonly values: JsonValue;
  readonly revision: string;
  readonly appliedRevision: string;
  readonly pendingReload: boolean;
  readonly compatible: boolean;
  readonly fieldErrors: readonly { readonly path: string; readonly message: string }[];
  readonly source: 'legacy' | 'managed' | 'defaults';
}
export interface PluginConfigurationTarget { readonly kind: 'server' | 'browser'; readonly id: string }
export interface PluginConfigurationController {
  get(target: PluginConfigurationTarget, signal: AbortSignal): Promise<PluginConfigurationView>;
  save(target: PluginConfigurationTarget, revision: string, values: JsonValue, signal: AbortSignal): Promise<PluginConfigurationView>;
  reset(target: PluginConfigurationTarget, revision: string, signal: AbortSignal): Promise<PluginConfigurationView>;
  apply(target: PluginConfigurationTarget, revision: string, signal: AbortSignal): Promise<PluginConfigurationView>;
}
