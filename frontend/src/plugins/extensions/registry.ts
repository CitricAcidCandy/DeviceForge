import { HostError, pageSlotId } from '../../plugin-sdk/index.ts';
import type {
  BeforeTaskSubmitHook,
  CommandContribution,
  ComponentContribution,
  Dispose,
  ExtensionAccess,
  ExtensionCatalog,
  HostContext,
  HostResult,
  JsonValue,
  ModuleContribution,
  PluginContributions,
  ServiceContribution,
  TaskSubmission,
  ThemeAccess,
  ServiceDirectoryEntry,
  ServerServiceAccess,
} from '../../plugin-sdk/index.ts';
import { validatePluginContributions } from '../contributions.ts';
import { createExtensionBus } from './bus.ts';
import { ensureOwner, invoke, isSubmission } from './invocation.ts';
import { contributionIds } from './types.ts';
import type { ExtensionOwner, Owned } from './types.ts';
import { createPluginScope } from '../scope.ts';
import { awaitActive } from './await-active.ts';
import { awaitLifecycle } from '../lifecycle.ts';
import { createThemeRegistry } from '../themes/registry.ts';
import type { ThemeAdapter } from '../themes/types.ts';
import { scopedThemeAccess } from '../theme-access.ts';
import { createServiceAccess } from './service-access.ts';
import { compileServiceSchema, checkServiceValue } from './service-schema.ts';
import { serviceInvocationContext, withinServiceCall } from './service-calls.ts';
import type { ServiceCallFrame } from './service-calls.ts';

export function createExtensionRegistry(themeAdapter?: ThemeAdapter) {
  const components = new Map<string, Owned<ComponentContribution>>();
  const modules = new Map<string, Owned<ModuleContribution>>();
  const commands = new Map<string, Owned<CommandContribution>>();
  const services = new Map<string, Owned<ServiceContribution>>();
  const serviceSchemas = new Map<string, { input: ReturnType<typeof compileServiceSchema>; output: ReturnType<typeof compileServiceSchema> }>();
  const hooks = new Map<string, Owned<BeforeTaskSubmitHook>>();
  const themes = createThemeRegistry(themeAdapter);
  const ids = new Set<string>();
  const registrations = new Map<string, ExtensionOwner>();
  const routes = new Set<string>();
  const bus = createExtensionBus();
  const lifetime = new AbortController();
  const pendingServices = new Set<string>();
  const ownerKey = (pluginId: string, generation: number) => JSON.stringify([pluginId, generation]);
  const serviceAlive = (entry: Owned<ServiceContribution>) => alive(entry) &&
    !pendingServices.has(ownerKey(entry.owner.pluginId, entry.owner.generation));
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
          .filter(serviceAlive)
          .map(({ owner, contribution: c }) => ({
            ...metadata(owner, c.id),
            version: c.version,
            inputSchema: c.inputSchema ?? true,
            outputSchema: c.outputSchema ?? true,
            available: true,
            reason: null,
          })),
      ),
    });
  }
  function catalog(): ExtensionCatalog {
    check();
    cached ??= build();
    return cached;
  }
  function serviceCatalog(): readonly ServiceDirectoryEntry[] {
    check();
    return [...services.values()].map((entry) => ({
      service: { id: entry.contribution.id, version: entry.contribution.version },
      contract: { inputSchema: structuredClone(entry.contribution.inputSchema ?? true), outputSchema: structuredClone(entry.contribution.outputSchema ?? true) },
      operation: null,
      provider: { id: entry.owner.pluginId, version: entry.owner.version ?? 'unknown', generation: String(entry.owner.generation) },
      available: serviceAlive(entry), reason: serviceAlive(entry) ? null : 'provider_not_active',
    }));
  }
  function register(owner: ExtensionOwner, value: PluginContributions): Dispose {
    check();
    ensureOwner(owner);
    validatePluginContributions(owner.pluginId, value);
    const additions = contributionIds(value);
    if (additions.some((id) => ids.has(id))) throw new Error('已登记的扩展标识发生冲突');
    const newRoutes = (value.modules ?? []).map((entry) => pageSlotId(owner.pluginId, entry.route));
    if (
      new Set(newRoutes).size !== newRoutes.length ||
      newRoutes.some((route) => routes.has(route))
    )
      throw new Error('模块路由冲突');
    const schemas = (value.services ?? []).map((entry) => ({ id: entry.id,
      input: compileServiceSchema(entry.inputSchema), output: compileServiceSchema(entry.outputSchema) }));
    const scope = createPluginScope(owner.context);
    const registeredOwner: ExtensionOwner = { ...owner, context: scope.context };
    const releaseThemes = value.themes?.length
      ? themes.stage(registeredOwner, value.themes)
      : undefined;
    for (const id of additions) { ids.add(id); registrations.set(id, registeredOwner); }
    for (const route of newRoutes) routes.add(route);
    for (const c of value.components ?? [])
      components.set(c.id, { owner: registeredOwner, contribution: c });
    for (const c of value.modules ?? [])
      modules.set(c.id, { owner: registeredOwner, contribution: c });
    for (const c of value.commands ?? [])
      commands.set(c.id, { owner: registeredOwner, contribution: c });
    for (const c of value.services ?? [])
      services.set(c.id, { owner: registeredOwner, contribution: c });
    for (const entry of schemas) serviceSchemas.set(entry.id, entry);
    for (const c of value.beforeTaskSubmit ?? [])
      hooks.set(c.id, { owner: registeredOwner, contribution: c });
    invalidate();
    let released = false;
    const stop = () => {
      if (released) return;
      released = true;
      owner.context.signal.removeEventListener('abort', stop);
      for (const id of additions) {
        if (registrations.get(id) !== registeredOwner) continue;
        registrations.delete(id);
        ids.delete(id);
        components.delete(id);
        modules.delete(id);
        commands.delete(id);
        services.delete(id);
        serviceSchemas.delete(id);
        hooks.delete(id);
      }
      for (const route of newRoutes) routes.delete(route);
      // 先撤销所有权，再运行释放回调；回调可同步登记新贡献，旧回收不得删除它。
      scope.close();
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
  function invocationContext(context: HostContext, frame: ServiceCallFrame): HostContext {
    return serviceInvocationContext(context, frame, (ref, input, signal, parent) =>
      callService(ref.id, ref.version, input, signal, parent), executeCommand);
  }
  function executeCommand(id: string, input: JsonValue, signal: AbortSignal, parent?: ServiceCallFrame): Promise<HostResult<JsonValue>> {
    check();
    const entry = commands.get(id);
    if (!entry) throw new HostError('protocol', 'command_unavailable', '命令已撤销或不存在');
    const combined = AbortSignal.any([signal, lifetime.signal, ...(parent ? [parent.signal] : [])]);
    const run = () => invoke(
      entry.owner,
      entry.contribution.execute,
      input,
      combined,
      () => commands.get(id) === entry,
      parent ? invocationContext(entry.owner.context, parent) : entry.owner.context,
    );
    // 经命令间接转调服务也属于原调用链，不能重置父期限和递归路径。
    return parent ? awaitLifecycle(run, combined, parent.deadline, '服务内命令调用') : run();
  }
  function callService(id: string, version: string, input: JsonValue, signal: AbortSignal, parent?: ServiceCallFrame): Promise<HostResult<JsonValue>> {
    check();
    const entry = services.get(id);
    if (!entry || !serviceAlive(entry) || entry.contribution.version !== version)
      throw new HostError('protocol', 'service_unavailable', '服务或请求版本不可用');
    const schema = serviceSchemas.get(id);
    checkServiceValue(schema?.input ?? null, input, 'input');
    return withinServiceCall(id, AbortSignal.any([signal, lifetime.signal, entry.owner.context.signal]), parent, (frame) => invoke(
      entry.owner,
      entry.contribution.invoke,
      input,
      frame.signal,
      () => services.get(id) === entry && serviceAlive(entry),
      invocationContext(entry.owner.context, frame),
    )).then((result) => {
      checkServiceValue(schema?.output ?? null, result.data, 'output', result.logId);
      return result;
    });
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
    deferServices = false,
    version?: string,
  ): HostContext {
    const key = ownerKey(pluginId, generation);
    if (deferServices) {
      pendingServices.add(key);
      track(() => { pendingServices.delete(key); });
    }
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
    const context: HostContext = Object.freeze<HostContext>({
      ...base,
      extensions,
      services: createServiceAccess({
        context: () => context, track,
        catalog: serviceCatalog,
        ...(base.services?.server ? { server: base.services.server } : {}),
        resolve: (ref) => {
          const entry = services.get(ref.id);
          return entry && serviceAlive(entry) && entry.contribution.version === ref.version ? entry : null;
        },
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        invoke: (ref, input, signal) => callService(ref.id, ref.version, input, signal),
      }),
      ...(scopedThemes ? { themes: scopedThemes } : {}),
    });
    const owner: ExtensionOwner = { pluginId, generation, context, ...(version ? { version } : {}) };
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
    serviceAccess(context: HostContext, server?: ServerServiceAccess) {
      const access: ReturnType<typeof createServiceAccess> = createServiceAccess({ context: () => ({ ...context, services: access }), track: context.onDispose, catalog: serviceCatalog,
        ...(server ? { server } : {}),
        resolve: (ref) => { const entry = services.get(ref.id); return entry && serviceAlive(entry) && entry.contribution.version === ref.version ? entry : null; },
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        invoke: (ref, input, signal) => callService(ref.id, ref.version, input, signal) });
      return access;
    },
    publishServices(pluginId: string, generation: number) {
      if (pendingServices.delete(ownerKey(pluginId, generation))) invalidate();
    },
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
      serviceSchemas.clear();
      pendingServices.clear();
      hooks.clear();
      ids.clear();
      registrations.clear();
      routes.clear();
      bus.clear();
      themes.dispose();
      listeners.clear();
      cached = null;
    },
  };
}
export type ExtensionRegistry = ReturnType<typeof createExtensionRegistry>;
