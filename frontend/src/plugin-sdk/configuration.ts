import type { Dispose, JsonValue } from './models.ts';

// 浏览器插件公开配置契约独立于服务器 HTTP 传输模型。
export interface ConfigurationDefinition {
  readonly version: number;
  readonly schema: JsonValue;
  readonly defaults: JsonValue;
  readonly apply_policy: 'next_invocation' | 'plugin_reload';
}
export interface ConfigurationAccess {
  readonly get: () => JsonValue;
  readonly subscribe: (listener: (values: JsonValue) => void) => Dispose;
}
