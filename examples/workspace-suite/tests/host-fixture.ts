import type {
  DataSourceDefinition, Dispose, HostContext, PluginContributions, PointDefinition,
  PointContribution,
  WorkspaceCatalog, WorkspaceContributions, WorkspaceInstance, WorkspaceInstanceInput, WorkspaceLayout, UiAccess,
} from '@deviceforge/plugin-sdk';

/** 只提供公开契约的内存端口，用于模板规则单元；不伪装成真实宿主安装。 */
export function hostFixture() {
  const signal = new AbortController(), prefix = 'workspace_suite.browser';
  const contributions: PluginContributions[] = [], points: PointDefinition[] = [], sources: DataSourceDefinition[] = [];
  const pointContributions: PointContribution[] = [];
  const registrations: WorkspaceContributions[] = [], opened: WorkspaceInstanceInput[] = [], closed: string[] = [];
  const layouts = new Map<string, WorkspaceLayout>(), instances = new Map<string, WorkspaceInstance>();
  const disposals: Dispose[] = [];
  let businessCalls = 0, mounted = 0, catalog: WorkspaceCatalog = { pages: [], views: [], workspaces: [] };
  const subscribers = new Set<() => void>();
  const notify = () => { for (const listener of [...subscribers]) listener(); };
  const ui: UiAccess = {
    async mount() { mounted++; return () => {}; },
    register(value) {
      registrations.push(value);
      catalog = {
        workspaces: [...catalog.workspaces, ...(value.workspaces ?? []).map((entry) => ({
          id: entry.id, title: entry.title, pluginId: prefix, generation: 1,
        }))],
        pages: [...catalog.pages, ...(value.pages ?? []).map((entry) => ({
          ...entry, workspaceId: entry.workspaceId ?? null, pluginId: prefix, generation: 1,
        }))],
        views: [...catalog.views, ...(value.views ?? []).map((entry) => ({
          id: entry.id, title: entry.title, provides: entry.provides ?? [], pluginId: prefix, generation: 1,
        }))],
      };
      for (const workspace of value.workspaces ?? [])
        if (workspace.defaultLayout && !layouts.has(workspace.id))
          layouts.set(workspace.id, structuredClone(workspace.defaultLayout));
      return () => {};
    },
    catalog: () => catalog,
    snapshot: () => ({ revision: 1, catalog, instances: [...instances.values()],
      layouts: [...layouts].map(([workspaceId, layout]) => ({ workspaceId, layout })) }),
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    open(input) {
      opened.push(structuredClone(input));
      const instance: WorkspaceInstance = {
        ...input, target: input.target ?? null, visible: input.visible ?? true,
        pluginId: prefix, generation: 1, providerGeneration: 1, state: 'ready', reason: null,
      };
      instances.set(input.instanceId, instance); notify();
      return instance;
    },
    close(id) { closed.push(id); instances.delete(id); notify(); },
    setTarget(id, target) {
      const instance = instances.get(id);
      if (!instance) throw new Error('测试实例不存在');
      const next = { ...instance, target, generation: instance.generation + 1 };
      instances.set(id, next); notify(); return next;
    },
    setVisible(id, visible) {
      const instance = instances.get(id);
      if (!instance) throw new Error('测试实例不存在');
      const next = { ...instance, visible };
      instances.set(id, next); notify(); return next;
    },
    selectProvider(id, provider) {
      const instance = instances.get(id);
      if (!instance) throw new Error('测试实例不存在');
      const next = { ...instance, provider };
      instances.set(id, next); notify(); return next;
    },
    readLayout: (id) => layouts.has(id) ? structuredClone(layouts.get(id) ?? null) : null,
    writeLayout(id, layout) { layouts.set(id, structuredClone(layout)); },
  };
  const context: HostContext = {
    apiVersion: 2, signal: signal.signal, ui,
    async listOperations() { businessCalls++; throw new Error('激活不应联网'); },
    async submit() { businessCalls++; throw new Error('激活不应提交'); },
    async getJob() { businessCalls++; throw new Error('激活不应查询'); },
    async cancelJob() { businessCalls++; throw new Error('不应自动取消'); },
    subscribeOperations: () => () => {}, onDispose(release) { disposals.push(release); return release; },
    extensions: {
      register(value) { contributions.push(value); return () => {}; },
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      async executeCommand() { throw new Error('单元未执行其他命令'); },
      async callService() { throw new Error('使用版本化公开服务'); },
      subscribeEvent: () => () => {}, emitEvent() {}, getState: () => undefined, setState() {},
      subscribeState: () => () => {},
      points: {
        define(value) { points.push(value); return () => {}; },
        contribute(value) {
          pointContributions.push(value);
          let current = value;
          const dispose = () => {
            const index = pointContributions.indexOf(current);
            if (index >= 0) pointContributions.splice(index, 1);
          };
          signal.signal.addEventListener('abort', dispose, { once: true });
          return { dispose, update(next) {
            const index = pointContributions.indexOf(current);
            if (index < 0) throw new Error('测试贡献已撤销');
            pointContributions[index] = next; current = next;
          } };
        },
        catalog: () => ({ definitions: [], contributions: [] }), list: () => [],
        selected: () => null, select() { throw new Error('激活不选择替换'); }, subscribe: () => () => {},
      },
    },
    data: {
      register(value) { sources.push(value); return () => {}; }, catalog: () => [],
      async read() { throw new Error('本测试直接验证服务'); },
      async write() { throw new Error('本测试直接验证服务'); }, subscribe: () => () => {},
    },
    services: {
      catalog: () => [],
      async call() { throw new Error('激活不调用业务'); },
      async callTyped() { throw new Error('激活不调用业务'); },
      whenAvailable() { throw new Error('主示例不需要功能依赖'); }, diagnostics: () => [],
    },
  };
  return {
    context, ui, signal, prefix, opened, closed, layouts, instances, contributions, points, pointContributions, sources, registrations,
    get counts() { return { businessCalls, mounted }; },
    setCatalog(value: WorkspaceCatalog) { catalog = value; },
    async dispose() { signal.abort(); for (const release of disposals.reverse()) await release(); },
  };
}
