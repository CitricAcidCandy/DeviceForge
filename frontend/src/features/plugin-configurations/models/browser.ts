import type {
  ConfigurationAccess,
  ConfigurationDefinition,
  JsonValue,
} from '../../../plugin-sdk/index.ts';
import { ApiError } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import {
  cloneSchemaValue,
  mapSchemaSecrets,
  mapSensitivePaths,
  readonlyIssues,
  schemaSensitivePaths,
  validateSchema,
} from '../../../utils/schema.ts';
import { readLegacyBrowserConfiguration } from '../services/legacy-browser.ts';
import type {
  BrowserConfigurationPersistence,
  BrowserConfigurationRecord,
} from '../types/browser.ts';
import type { PluginConfigurationView } from '../types/index.ts';
import { browserConfigurationView, redactBrowserConfiguration } from '../utils/browser-view.ts';

export function createBrowserConfigurations(options: {
  readonly baseUrl: string;
  readonly persistence: BrowserConfigurationPersistence;
  readonly legacyStorage?: Storage | undefined;
  readonly signal?: AbortSignal;
}) {
  const lifetime = new AbortController();
  const definitions = new Map<string, ConfigurationDefinition | null>();
  const records = new Map<string, BrowserConfigurationRecord | null>();
  const listeners = new Map<string, Set<(values: JsonValue) => void>>();
  const live = new Map<string, JsonValue>();
  const prepared = new Map<string, string>();
  const applying = new Map<string, { revision: string }>();
  const queues = new Map<string, Promise<unknown>>();
  const combined = (signal: AbortSignal) =>
    AbortSignal.any([signal, lifetime.signal, ...(options.signal ? [options.signal] : [])]);
  function request<T>(
    id: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const current = combined(signal);
    const pending = (queues.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        current.throwIfAborted();
        const value = await abortable(run(current), current);
        current.throwIfAborted();
        return value;
      });
    queues.set(id, pending);
    void pending
      .finally(() => {
        if (queues.get(id) === pending) queues.delete(id);
      })
      .catch(() => undefined);
    return abortable(pending, current);
  }
  function definition(id: string): ConfigurationDefinition | null {
    if (!definitions.has(id)) throw new Error('插件配置声明尚未读取');
    return definitions.get(id) ?? null;
  }
  function snapshot(id: string): PluginConfigurationView {
    return browserConfigurationView(id, definition(id), records.get(id) ?? null);
  }
  function view(id: string): PluginConfigurationView {
    return redactBrowserConfiguration(snapshot(id), records.get(id) ?? null);
  }
  async function refresh(
    id: string,
    signal: AbortSignal,
  ): Promise<BrowserConfigurationRecord | null> {
    const config = definition(id);
    if (!config) {
      records.set(id, null);
      return null;
    }
    let stored = await options.persistence.get(id, signal);
    signal.throwIfAborted();
    if (!stored) {
      const legacy = readLegacyBrowserConfiguration(options.baseUrl, id, options.legacyStorage);
      const values = legacy?.values ?? cloneSchemaValue(config.defaults);
      if (values === null || typeof values !== 'object' || Array.isArray(values))
        throw new Error('浏览器插件配置必须是 JSON 对象');
      const initial: BrowserConfigurationRecord = legacy ?? {
        version: config.version,
        values,
        revision: 'defaults',
        applied: 'defaults',
        sensitivePaths: [],
      };
      const sensitivePaths = [
        ...new Set([...initial.sensitivePaths, ...schemaSensitivePaths(config.schema, values)]),
      ];
      try {
        stored = await options.persistence.save(id, null, { ...initial, sensitivePaths }, signal);
      } catch (reason) {
        signal.throwIfAborted();
        if (!(reason instanceof ApiError) || reason.status !== 409) throw reason;
        stored = await options.persistence.get(id, signal);
        if (!stored) throw reason;
      }
      signal.throwIfAborted();
    }
    records.set(id, stored);
    return stored;
  }
  function assertCurrent(id: string, revision: string): void {
    if ((records.get(id)?.revision ?? 'defaults') !== revision)
      throw new Error('配置已在其他窗口修改，请刷新配置后重新保存');
  }
  async function write(
    id: string,
    revision: string,
    values: JsonValue,
    signal: AbortSignal,
    restoring = false,
  ): Promise<PluginConfigurationView> {
    const stored = await refresh(id, signal);
    assertCurrent(id, revision);
    const config = definition(id);
    if (!config) throw new Error('此插件无需配置');
    const previous = snapshot(id).values;
    const historical = stored?.sensitivePaths ?? [];
    const restored = mapSensitivePaths(
      mapSchemaSecrets(config.schema, values, previous, 'restore'),
      historical,
      previous,
      'restore',
    );
    const errors = [
      ...(restoring ? [] : readonlyIssues(config.schema, previous, restored)),
      ...validateSchema(config.schema, restored),
    ];
    if (restored === null || typeof restored !== 'object' || Array.isArray(restored))
      errors.push({ path: '', message: '浏览器插件配置必须是 JSON 对象' });
    if (errors.length) return { ...view(id), compatible: false, fieldErrors: errors };
    if (restored === null || typeof restored !== 'object' || Array.isArray(restored))
      throw new Error('浏览器插件配置必须是 JSON 对象');
    const next = crypto.randomUUID();
    const result = await options.persistence.save(
      id,
      stored?.revision ?? null,
      {
        version: config.version,
        values: restored,
        revision: next,
        applied: config.apply_policy === 'next_invocation' ? next : (stored?.applied ?? 'defaults'),
        sensitivePaths: [
          ...new Set([...historical, ...schemaSensitivePaths(config.schema, restored)]),
        ],
      },
      signal,
    );
    signal.throwIfAborted();
    records.set(id, result);
    if (config.apply_policy === 'next_invocation') {
      live.set(id, cloneSchemaValue(result.values));
      for (const listener of listeners.get(id) ?? []) listener(cloneSchemaValue(result.values));
    }
    return view(id);
  }
  return {
    define(id: string, config: ConfigurationDefinition | null) {
      lifetime.signal.throwIfAborted();
      definitions.set(id, config);
    },
    get(id: string, signal: AbortSignal) {
      return request(id, signal, async (current) => {
        await refresh(id, current);
        return view(id);
      });
    },
    save(id: string, revision: string, values: JsonValue, signal: AbortSignal) {
      return request(id, signal, (current) => write(id, revision, values, current));
    },
    reset(id: string, revision: string, signal: AbortSignal) {
      return request(id, signal, (current) => {
        const config = definition(id);
        if (!config) throw new Error('此插件无需配置');
        return write(id, revision, cloneSchemaValue(config.defaults), current, true);
      });
    },
    prepare(
      id: string,
      config: ConfigurationDefinition | null,
      signal: AbortSignal,
    ): Promise<ConfigurationAccess | undefined> {
      return request(id, signal, async (current) => {
        definitions.set(id, config);
        if (!config) return undefined;
        await refresh(id, current);
        const value = snapshot(id);
        const expected = applying.get(id)?.revision;
        if (expected !== undefined) assertCurrent(id, expected);
        if (!value.compatible)
          throw new Error(
            `插件 ${id} 配置无效：${value.fieldErrors.map((error) => `${error.path} ${error.message}`).join('；')}`,
          );
        live.set(id, cloneSchemaValue(value.values));
        prepared.set(id, value.revision);
        return {
          get: () => cloneSchemaValue(live.get(id) ?? value.values),
          subscribe(listener) {
            const subscribers = listeners.get(id) ?? new Set();
            subscribers.add(listener);
            listeners.set(id, subscribers);
            return () => {
              subscribers.delete(listener);
            };
          },
        };
      });
    },
    markApplied(id: string, signal: AbortSignal) {
      return request(id, signal, async (current) => {
        if (!definition(id)) return;
        const expected = prepared.get(id);
        if (expected === undefined) throw new Error('插件配置尚未准备，不能确认已应用');
        const stored = await refresh(id, current);
        assertCurrent(id, expected);
        if (!stored || stored.applied === stored.revision) return;
        const result = await options.persistence.save(
          id,
          stored.revision,
          { ...stored, applied: stored.revision },
          current,
        );
        current.throwIfAborted();
        records.set(id, result);
      });
    },
    assertRevision(id: string, revision: string, signal: AbortSignal) {
      return request(id, signal, async (current) => {
        await refresh(id, current);
        assertCurrent(id, revision);
      });
    },
    async apply(
      id: string,
      revision: string,
      signal: AbortSignal,
      reload: (signal: AbortSignal) => Promise<void>,
    ) {
      const current = combined(signal);
      current.throwIfAborted();
      if (applying.has(id)) throw new Error('插件配置正在应用，请等待完成');
      const operation = { revision };
      applying.set(id, operation);
      try {
        await request(id, current, async (active) => {
          await refresh(id, active);
          assertCurrent(id, revision);
        });
        await abortable(reload(current), current);
        return await request(id, current, async (active) => {
          await refresh(id, active);
          assertCurrent(id, revision);
          return view(id);
        });
      } finally {
        if (applying.get(id) === operation) applying.delete(id);
      }
    },
    dispose() {
      lifetime.abort();
      definitions.clear();
      records.clear();
      listeners.clear();
      live.clear();
      prepared.clear();
      applying.clear();
      queues.clear();
    },
  };
}
export type BrowserConfigurations = ReturnType<typeof createBrowserConfigurations>;
