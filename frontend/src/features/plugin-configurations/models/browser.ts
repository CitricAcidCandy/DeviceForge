import type { ConfigurationAccess, ConfigurationDefinition, JsonValue } from '../../../plugin-sdk/index.ts';
import { cloneSchemaValue, isSchemaValue, mapSchemaSecrets, readonlyIssues, redactSchemaDefaults, validateSchema } from '../../../utils/schema.ts';
import type { PluginConfigurationView } from '../types/index.ts';

interface BrowserRecord { readonly version: number; readonly values: JsonValue; readonly revision: string; readonly applied: string }
export function createBrowserConfigurations(baseUrl: string, storage?: Storage) {
  const definitions = new Map<string, ConfigurationDefinition | null>();
  const listeners = new Map<string, Set<(values: JsonValue) => void>>();
  const live = new Map<string, JsonValue>();
  const prepared = new Map<string, string>();
  const namespace = new URL(baseUrl).toString().replace(/\/$/, '');
  const key = (id: string) => `deviceforge.plugin-configuration:${encodeURIComponent(namespace)}:${encodeURIComponent(id)}`;
  function read(id: string): BrowserRecord | null {
    const text = storage?.getItem(key(id));
    if (!text) return null;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('version' in value) || !('values' in value) || !('revision' in value) || !('applied' in value) ||
      typeof value.version !== 'number' || !isSchemaValue(value.values) || typeof value.revision !== 'string' || typeof value.applied !== 'string')
      throw new Error('浏览器插件配置记录损坏，请恢复默认配置');
    return { version: value.version, values: value.values, revision: value.revision, applied: value.applied };
  }
  function raw(id: string): PluginConfigurationView {
    if (!definitions.has(id)) throw new Error('插件配置声明尚未读取');
    const definition = definitions.get(id) ?? null;
    const stored = read(id);
    const values = cloneSchemaValue(stored?.values ?? definition?.defaults ?? {});
    const fieldErrors = definition ? validateSchema(definition.schema, values) : [];
    const compatible = (!stored || stored.version === definition?.version) && fieldErrors.length === 0;
    return { kind: 'browser', id, definition, values, revision: stored?.revision ?? 'defaults', appliedRevision: stored?.applied ?? 'defaults',
      pendingReload: !!definition && definition.apply_policy === 'plugin_reload' && stored?.revision !== stored?.applied,
      compatible, fieldErrors: compatible ? fieldErrors : [...fieldErrors, ...(!stored || stored.version === definition?.version ? [] : [{ path: '', message: '配置版本与插件声明不兼容，请恢复默认或修正配置' }])], source: stored ? 'managed' : 'defaults' };
  }
  function get(id: string): PluginConfigurationView {
    const snapshot = raw(id);
    return snapshot.definition ? { ...snapshot, values: mapSchemaSecrets(snapshot.definition.schema, snapshot.values), definition: {
      ...snapshot.definition, schema: redactSchemaDefaults(snapshot.definition.schema), defaults: mapSchemaSecrets(snapshot.definition.schema, snapshot.definition.defaults),
    } } : snapshot;
  }
  function assertRevision(id: string, revision: string) {
    if ((read(id)?.revision ?? 'defaults') !== revision) throw new Error('配置已在其他窗口修改，请刷新配置后重新保存');
  }
  function write(id: string, revision: string, values: JsonValue, restoring = false): PluginConfigurationView {
    assertRevision(id, revision);
    const definition = definitions.get(id);
    if (!definition) throw new Error('此插件无需配置');
    const previous = raw(id).values;
    const restored = mapSchemaSecrets(definition.schema, values, previous, 'restore');
    const errors = [...(restoring ? [] : readonlyIssues(definition.schema, previous, restored)), ...validateSchema(definition.schema, restored)];
    if (errors.length) return { ...get(id), compatible: false, fieldErrors: errors };
    if (!storage) throw new Error('当前浏览器不支持持久化配置');
    const next = crypto.randomUUID();
    const applied = definition.apply_policy === 'next_invocation' ? next : read(id)?.applied ?? 'defaults';
    storage.setItem(key(id), JSON.stringify({ version: definition.version, values: restored, revision: next, applied }));
    if (definition.apply_policy === 'next_invocation') {
      live.set(id, cloneSchemaValue(restored));
      for (const listener of listeners.get(id) ?? []) listener(cloneSchemaValue(restored));
    }
    return get(id);
  }
  return {
    define(id: string, definition: ConfigurationDefinition | null) { definitions.set(id, definition); },
    get,
    save: write,
    reset(id: string, revision: string) {
      const definition = definitions.get(id);
      if (!definition) throw new Error('此插件无需配置');
      return write(id, revision, cloneSchemaValue(definition.defaults), true);
    },
    prepare(id: string, definition: ConfigurationDefinition | null): ConfigurationAccess | undefined {
      definitions.set(id, definition);
      if (!definition) return undefined;
      const snapshot = raw(id);
      if (!snapshot.compatible) throw new Error(`插件 ${id} 配置无效：${snapshot.fieldErrors.map((error) => `${error.path} ${error.message}`).join('；')}`);
      live.set(id, cloneSchemaValue(snapshot.values));
      prepared.set(id, snapshot.revision);
      return {
        get: () => cloneSchemaValue(live.get(id) ?? snapshot.values),
        subscribe(listener) {
          const subscribers = listeners.get(id) ?? new Set();
          subscribers.add(listener); listeners.set(id, subscribers);
          return () => { subscribers.delete(listener); };
        },
      };
    },
    markApplied(id: string) {
      const stored = read(id);
      if (stored && storage && prepared.get(id) === stored.revision) storage.setItem(key(id), JSON.stringify({ ...stored, applied: stored.revision }));
    },
    assertRevision,
    dispose() { definitions.clear(); listeners.clear(); live.clear(); prepared.clear(); },
  };
}
export type BrowserConfigurations = ReturnType<typeof createBrowserConfigurations>;
