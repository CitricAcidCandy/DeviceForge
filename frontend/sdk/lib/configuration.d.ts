import type { Dispose, JsonValue } from './models.js';
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
