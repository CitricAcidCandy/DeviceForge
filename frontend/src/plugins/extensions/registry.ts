import { HostError } from '../../plugin-sdk/index.ts';
import type {
  BeforeTaskSubmitHook,
  CommandContribution,
  ComponentContribution,
  Dispose,
  ExtensionAccess,
  ExtensionCatalog,
  HostContext,
  JsonValue,
  ModuleContribution,
  PluginContributions,
  ServiceContribution,
  TaskSubmission,
  ThemeAccess,
} from '../../plugin-sdk/index.ts';
import { validatePluginContributions } from '../contributions.ts';
import { createExtensionBus } from './bus.ts';
import { ensureOwner, invoke, isSubmission } from './invocation.ts';
import { contributionIds } from './types.ts';
import type { ExtensionOwner, Owned } from './types.ts';
import { createPluginScope } from '../scope.ts';
import { awaitActive } from './await-active.ts';
import { createThemeRegistry } from '../themes/registry.ts';
import type { ThemeAdapter } from '../themes/types.ts';
import { scopedThemeAccess } from '../theme-access.ts';

export function createExtensionRegistry(themeAdapter?: ThemeAdapter) {
  const components = new Map<string, Owned<ComponentContribution>>();
  const modules = new Map<string, Owned<ModuleContribution>>();
  const commands = new Map<string, Owned<CommandContribution>>();
  const services = new Map<string, Owned<ServiceContribution>>();
  const hooks = new Map<string, Owned<BeforeTaskSubmitHook>>();
  const themes = createThemeRegistry(themeAdapter);
  const ids = new Set<string>();
  const routes = new Set<string>();
  const bus = createExtensionBus();
  const lifetime = new AbortController();
  let closed = false;
  const check = () => {
    if (closed) throw new HostError('cancelled', 'registry_closed', '扩展注册表已关闭');
  };
  const metadata = (owner: ExtensionOwner, id: string) => ({
    id,
    pluginId: owner.pluginId,
    generation: owner.generation,
  });
  const alive = <T>(entry: Owned<T>) => !entry.owner.context.signal.aborted;
  const listeners = new Set<() => void>();
  // 目录快照必须引用稳定：React 侧用 useSyncExternalStore 逐帧读取，现算会导致无限重渲染。
  let cached: ExtensionCatalog | null = null;
  function invalidate() {
    cached = null;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 订阅方的失败不能影响注册表本身的一致性与其余订阅者。
      }
    }
  }
  function build(): ExtensionCatalog {
    return Object.freeze({
      components: Object.freeze(
        [...components.values()]
          .filter(alive)
          .map(({ owner, contribution: c }) => ({
            ...metadata(owner, c.id),
            title: c.title,
            slot: c.slot,
            mode: c.mode ?? 'append',
          })),
      ),
      modules: Object.freeze(
        [...modules.values()]
          .filter(alive)
          .map(({ owner, contribution: c }) => ({
            ...metadata(owner, c.id),
            title: c.title,
            route: c.route,
          })),
      ),
      commands: Object.freeze(
        [...commands.values()]
          .filter(alive)
          .map(({ owner, contribution: c }) => ({ ...metadata(owner, c.id), title: c.title })),
      ),
      services: Object.freeze(
        [...services.values()]
          .filter(alive)
          .map(({ owner, contribution: c }) => ({
            ...metadata(owner, c.id),
            version: c.version,
          })),
      ),
    });
  }
  function catalog(): ExtensionCatalog {
    check();
    cached ??= build();
    return cached;
  }
  function register(owner: ExtensionOwner, value: PluginContributions): Dispose {
    check();
    ensureOwner(owner);
    validatePluginContributions(owner.pluginId, value);
    const additions = contributionIds(value);
    if (additions.some((id) => ids.has(id))) throw new Error('已登记的扩展标识发生冲突');
    const newRoutes = (value.modules ?? []).map((entry) => entry.route);
    if (
      new Set(newRoutes).size !== newRoutes.length ||
      newRoutes.some((route) => routes.has(route))
    )
      throw new Error('模块路由冲突');
    const scope = createPluginScope(owner.context);
    const registeredOwner: ExtensionOwner = { ...owner, context: scope.context };
    const releaseThemes = value.themes?.length
      ? themes.stage(registeredOwner, value.themes)
      : undefined;
    for (const id of additions) ids.add(id);
    for (const route of newRoutes) routes.add(route);
    for (const c of value.components ?? [])
      components.set(c.id, { owner: registeredOwner, contribution: c });
    for (const c of value.modules ?? [])
      modules.set(c.id, { owner: registeredOwner, contribution: c });
    for (const c of value.commands ?? [])
      commands.set(c.id, { owner: registeredOwner, contribution: c });
    for (const c of value.services ?? [])
      services.set(c.id, { owner: registeredOwner, contribution: c });
    for (const c of value.beforeTaskSubmit ?? [])
      hooks.set(c.id, { owner: registeredOwner, contribution: c });
    invalidate();
    let released = false;
    const stop = () => {
      if (released) return;
      released = true;
      owner.context.signal.removeEventListener('abort', stop);
      scope.close();
      for (const id of additions) {
        ids.delete(id);
        components.delete(id);
        modules.delete(id);
        commands.delete(id);
        services.delete(id);
        hooks.delete(id);
      }
      for (const route of newRoutes) routes.delete(route);
      releaseThemes?.();
      invalidate();
    };
    owner.context.signal.addEventListener('abort', stop, { once: true });
    if (owner.context.signal.aborted) stop();
    else if (releaseThemes) themes.publish();
    return () => {
      stop();
      return scope.dispose();
    };
  }
  function executeCommand(id: string, input: JsonValue, signal: AbortSignal) {
    check();
    const entry = commands.get(id);
    if (!entry) throw new HostError('protocol', 'command_unavailable', '命令已撤销或不存在');
    return invoke(
      entry.owner,
      entry.contribution.execute,
      input,
      AbortSignal.any([signal, lifetime.signal]),
      () => commands.get(id) === entry,
    );
  }
  function callService(id: string, version: string, input: JsonValue, signal: AbortSignal) {
    check();
    const entry = services.get(id);
    if (!entry || entry.contribution.version !== version)
      throw new HostError('protocol', 'service_unavailable', '服务或请求版本不可用');
    return invoke(
      entry.owner,
      entry.contribution.invoke,
      input,
      AbortSignal.any([signal, lifetime.signal]),
      () => services.get(id) === entry,
    );
  }
  function access(
    pluginId: string,
    generation: number,
    signal: AbortSignal,
    track: (release: Dispose) => Dispose,
    dynamic?: (value: PluginContributions) => Dispose,
  ): ExtensionAccess {
    const current = () => {
      check();
      if (signal.aborted) throw new HostError('cancelled', 'extension_revoked', '扩展上下文已撤销');
    };
    return Object.freeze<ExtensionAccess>({
      catalog: () => {
        current();
        return catalog();
      },
      executeCommand: (id, input, caller) => {
        current();
        return executeCommand(id, input, AbortSignal.any([caller, signal]));
      },
      callService: (id, version, input, caller) => {
        current();
        return callService(id, version, input, AbortSignal.any([caller, signal]));
      },
      subscribeEvent: (name, listener) => {
        current();
        return track(
          bus.subscribeEvent(name, (event) => {
            if (!signal.aborted) listener(event);
          }),
        );
      },
      emitEvent: (name, data) => {
        current();
        bus.emit(pluginId, generation, name, data);
      },
      getState: (key) => {
        current();
        return bus.get(pluginId, key);
      },
      setState: (key, value) => {
        current();
        bus.set(pluginId, key, value);
      },
      subscribeState: (key, listener) => {
        current();
        return track(
          bus.subscribeState(pluginId, key, (value) => {
            if (!signal.aborted) listener(value);
          }),
        );
      },
      ...(dynamic
        ? {
            register: (value: PluginContributions) => {
              current();
              return track(dynamic(value));
            },
          }
        : {}),
    });
  }
  function attach(
    pluginId: string,
    generation: number,
    base: HostContext,
    track: (dispose: Dispose) => Dispose,
  ): HostContext {
    const extensions = access(pluginId, generation, base.signal, track, (value) =>
      register(owner, value),
    );
    const scopedThemes = scopedThemeAccess(
      themes.access,
      () => {
        if (base.signal.aborted)
          throw new HostError('cancelled', 'plugin_unloaded', '主题上下文已撤销');
      },
      base.signal,
      track,
    );
    const context = Object.freeze<HostContext>({
      ...base,
      extensions,
      ...(scopedThemes ? { themes: scopedThemes } : {}),
    });
    const owner: ExtensionOwner = { pluginId, generation, context };
    track(() => bus.clearOwner(pluginId));
    return context;
  }
  async function beforeTaskSubmit(
    initial: TaskSubmission,
    signal: AbortSignal,
  ): Promise<TaskSubmission> {
    check();
    const current = AbortSignal.any([signal, lifetime.signal]);
    if (current.aborted) throw new HostError('cancelled', 'cancelled', '任务提交等待已取消');
    if (!isSubmission(initial))
      throw new HostError('protocol', 'invalid_submission', '任务输入无效');
    let value = initial;
    const ordered = [...hooks.values()]
      .filter(alive)
      .sort(
        (a, b) =>
          (a.contribution.priority ?? 0) - (b.contribution.priority ?? 0) ||
          a.contribution.id.localeCompare(b.contribution.id),
      );
    for (const entry of ordered) {
      const { owner, contribution } = entry;
      ensureOwner(owner);
      if (hooks.get(contribution.id) !== entry || current.aborted)
        throw new HostError('cancelled', 'hook_revoked', '任务钩子已撤销');
      const combined = AbortSignal.any([current, owner.context.signal]);
      const next: unknown = await awaitActive(
        () => contribution.transform(value, owner.context, combined),
        combined,
      );
      ensureOwner(owner);
      if (combined.aborted || hooks.get(contribution.id) !== entry)
        throw new HostError('cancelled', 'stale_hook', '晚到钩子结果已撤销');
      if (!isSubmission(next))
        throw new HostError('protocol', 'invalid_hook_result', '任务钩子返回无效输入');
      value = next;
    }
    if (current.aborted) throw new HostError('cancelled', 'cancelled', '任务提交等待已取消');
    return value;
  }
  return {
    catalog,
    subscribe(listener: () => void) {
      check();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register,
    attach,
    executeCommand,
    callService,
    beforeTaskSubmit,
    hostAccess: (context: HostContext) => access('host', 0, context.signal, context.onDispose),
    themeAccess: (context: HostContext): ThemeAccess =>
      Object.freeze<ThemeAccess>({
        snapshot: () => {
          if (context.signal.aborted)
            throw new HostError('cancelled', 'themes_closed', '宿主主题入口已关闭');
          return themes.access.snapshot();
        },
        select: (id) => {
          if (context.signal.aborted)
            throw new HostError('cancelled', 'themes_closed', '宿主主题入口已关闭');
          themes.access.select(id);
        },
        subscribe: (listener) => {
          if (context.signal.aborted)
            throw new HostError('cancelled', 'themes_closed', '宿主主题入口已关闭');
          return context.onDispose(
            themes.access.subscribe((snapshot) => {
              if (!context.signal.aborted) listener(snapshot);
            }),
          );
        },
      }),
    component: (id: string) => {
      check();
      return components.get(id);
    },
    module: (id: string) => {
      check();
      return modules.get(id);
    },
    dispose() {
      closed = true;
      lifetime.abort();
      components.clear();
      modules.clear();
      commands.clear();
      services.clear();
      hooks.clear();
      ids.clear();
      routes.clear();
      bus.clear();
      themes.dispose();
      listeners.clear();
      cached = null;
    },
  };
}
export type ExtensionRegistry = ReturnType<typeof createExtensionRegistry>;
