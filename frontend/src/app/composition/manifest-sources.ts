import { normalizeManifest } from '@deviceforge/plugin-manifest';
import type { WebPlugin } from '../../plugin-sdk/index.ts';
import { readPluginModule } from '../../plugins/contracts.ts';

export interface OfficialPluginSource {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly loader: (signal: AbortSignal) => Promise<unknown>;
}
export interface OfficialSourceDirectory {
  readonly sources: readonly OfficialPluginSource[];
  readonly diagnostics: readonly { readonly path: string; readonly message: string }[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 开发目录与发布清单共享身份，宿主不维护第二份业务插件或路由枚举。 */
export function manifestPluginSources(
  manifests: Readonly<Record<string, unknown>>,
  entries: Readonly<Record<string, () => Promise<unknown>>>,
): OfficialSourceDirectory {
  const sources: OfficialPluginSource[] = [];
  const diagnostics: { path: string; message: string }[] = [];
  for (const [path, value] of Object.entries(manifests).sort(([first], [second]) => first.localeCompare(second))) {
    try {
      const declaration = normalizeManifest(value);
      const browsers = declaration.components.filter((component) => component.kind === 'browser');
      if (browsers.length !== 1) throw new Error('随附开发工程必须恰好声明一个浏览器组件');
      const component = browsers[0];
      if (!component) throw new Error('开发清单缺少浏览器组件');
      const entryPath = path.replace(/manifest\.json$/, 'src/index.ts');
      const load = entries[entryPath];
      if (!load) throw new Error('独立工程缺少约定的源码入口 src/index.ts');
      const identity = Object.freeze({ id: component.id, version: component.version, apiVersion: 2 as const });
      sources.push(Object.freeze({
        id: identity.id, version: identity.version, title: declaration.name,
        async loader(signal: AbortSignal): Promise<WebPlugin> {
          signal.throwIfAborted();
          const module = await load();
          signal.throwIfAborted();
          const candidate = record(module) && 'default' in module ? module.default : module;
          const produced: unknown = typeof candidate === 'function' ? await candidate(identity) : candidate;
          signal.throwIfAborted();
          const declaredConfiguration = component.plugin.configuration;
          // 与发布包装一致，配置只在manifest声明；源码工厂无需再抄一份。
          const plugin = readPluginModule(declaredConfiguration != null && record(produced)
            ? { ...produced, configuration: structuredClone(declaredConfiguration) } : produced);
          if (plugin.id !== identity.id || plugin.version !== identity.version)
            throw new Error('随附插件导出身份与唯一开发清单不一致');
          return plugin;
        },
      }));
    } catch (error) {
      diagnostics.push({ path, message: error instanceof Error ? error.message : '开发插件清单无效' });
    }
  }
  const duplicates = new Set(sources.filter((source, at) =>
    sources.findIndex((candidate) => candidate.id === source.id) !== at).map((source) => source.id));
  for (const id of duplicates) diagnostics.push({ path: id, message: '多个开发清单声明相同浏览器组件，全部排除' });
  return Object.freeze({
    sources: Object.freeze(sources.filter((source) => !duplicates.has(source.id))),
    diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze(entry))),
  });
}

