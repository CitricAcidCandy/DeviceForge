import { createUiCollector, createDebugActions, pickDocumentOnce } from '../../plugins/debugger/index.ts';
import type { DebugSurface } from '../../plugins/debugger/index.ts';
import { pageSlotId } from '../../plugin-sdk/index.ts';
import type { AttachedDebug, LocalDebuggerOptions, ResolvedTarget } from './types.ts';
import { action, assertion, query } from './ui-parameters.ts';
import { fail, integer, json, keys, object, text } from './validation.ts';
import { publicOverview } from './overview.ts';
import { navigate } from './navigation.ts';
import { hostPick } from './host-pick.ts';
import { isManagedPortalRoot, resolveOwnedPortalRoot } from '../portal-ownership.ts';

export function clearCollectors(entry: AttachedDebug): void {
  entry.session.abort();
  for (const { collector, actions } of entry.collectors.values()) {
    actions.dispose(); collector.dispose();
  }
  entry.collectors.clear();
}

export function createLocalUi(options: LocalDebuggerOptions, entries: () => Iterable<AttachedDebug>) {
  const ids = new WeakMap<Element, string>();
  let sequence = 0;
  let picking = false;
  function roots(target: ResolvedTarget) {
    const found = options.document.querySelectorAll(
      `[data-deviceforge-plugin="${target.plugin_id}"][data-deviceforge-generation="${target.generation}"]`,
    );
    const candidates = new Set<Element>(found);
    const result: { id: string; element: Element; kind: 'panel' | 'surface'; contribution: string }[] = [];
    for (const element of found) {
      if (element.closest('[data-deviceforge-debugger-internal]')) continue;
      const managedPortal = isManagedPortalRoot(element);
      if (managedPortal) {
        const ownership = resolveOwnedPortalRoot(element);
        // 失效Portal不得降级成旧surface，来源也必须仍是本次明确目标的有效根。
        if (!ownership || !candidates.has(ownership.anchor) ||
            ownership.anchor.closest('[data-deviceforge-debugger-internal]')) continue;
      }
      const panel = element.getAttribute('data-deviceforge-panel');
      const extension = element.getAttribute('data-deviceforge-extension');
      if (panel === null && extension === null) continue;
      if (result.length === 64) return fail('limit_exceeded', '选定插件挂载根超过64项，不能任意截取');
      let id = ids.get(element);
      if (!id) { id = `root-${++sequence}`; ids.set(element, id); }
      result.push({ id, element, kind: !managedPortal && panel !== null ? 'panel' : 'surface',
        contribution: managedPortal ? extension ?? '' : panel ?? extension ?? '' });
    }
    return result;
  }
  function describe(target: ResolvedTarget) {
    return roots(target).map(({ id, kind, contribution }) => ({ root_id: id, kind, contribution_id: contribution }));
  }
  function slots(target: ResolvedTarget) {
    const mounted = new Set(roots(target).map((root) => root.contribution));
    const catalog = options.extensions.catalog();
    const declared = new Set((options.slots ?? []).map((slot) => slot.id));
    const instantiated = new Set<string>();
    // 只枚举公开锚点的属性，不扫描其后代，也不从普通DOM推导新槽位。
    for (const anchor of options.document.querySelectorAll('[data-deviceforge-slot], [data-deviceforge-surface]')) {
      for (const attribute of ['data-deviceforge-slot', 'data-deviceforge-surface']) {
        const id = anchor.getAttribute(attribute);
        if (id !== null && declared.has(id)) instantiated.add(id);
      }
    }
    const current = (item: { pluginId: string; generation: number }) =>
      item.pluginId === target.plugin_id && String(item.generation) === target.generation;
    const mounts = mountCatalog(target);
    return (options.slots ?? []).map((slot) => ({
      id: slot.id, label: slot.label, modes: [...slot.modes], route: slot.route ?? null, description: slot.description,
      instantiated: instantiated.has(slot.id),
      mounted_by_target: catalog.components.some((item) => current(item) && item.slot === slot.id && mounted.has(item.id)) ||
        catalog.modules.some((item) => current(item) && pageSlotId(item.pluginId, item.route) === slot.id && mounted.has(item.id)),
      target_contributions: mounts.filter((item) => item.slot_id === slot.id),
      evidence: { instantiated: 'host-public-slot-or-surface-anchor', mounted_by_target: 'selected-plugin-mounted-contributions' },
    }));
  }
  function mountCatalog(target: ResolvedTarget) {
    const catalog = options.extensions.catalog();
    const mountedRoots = roots(target);
    const observed = new Set(mountedRoots.map((root) => root.contribution));
    const owner = { pluginId: target.plugin_id, generation: Number(target.generation) };
    const current = (item: { pluginId: string; generation: number }) => item.pluginId === owner.pluginId && item.generation === owner.generation;
    const runtime = options.manager().diagnosticSnapshot().find((item) => item.id === owner.pluginId && item.generation === owner.generation);
    const workspace = options.extensions.workspaces.snapshot();
    const views = new Map(workspace.catalog.views.filter(current).map((view) => [view.id, view.title]));
    const workspaceMounts = workspace.instances.flatMap((instance) => {
      const provider = instance.provider;
      if (provider?.pluginId !== owner.pluginId || instance.providerGeneration !== owner.generation) return [];
      const id = `workspace.${instance.instanceId}.${instance.generation}`;
      // ready只表示提供者可用；当前实例的实际锚点才是DOM挂载证据。
      const mounted = mountedRoots.some((root) => root.contribution === id &&
        root.element.getAttribute('data-deviceforge-workspace-instance') === instance.instanceId &&
        root.element.getAttribute('data-deviceforge-workspace-view') === provider.viewId &&
        root.element.getAttribute('data-deviceforge-workspace-generation') === String(instance.generation));
      return [{
        id, kind: 'workspace', label: views.get(provider.viewId) ?? provider.viewId, owner, slot_id: null,
        path: null, mode: null, workspace_id: instance.workspaceId, instance_id: instance.instanceId,
        view_id: provider.viewId, instance_generation: instance.generation,
        mounted, dom_observed: mounted, evidence: 'selected-plugin-workspace-instance-anchor',
      }];
    });
    return [
      ...(runtime?.panels ?? []).map((panel) => ({ id: panel.id, kind: 'panel', label: panel.title, owner, slot_id: null,
        path: null, mode: null, mounted: panel.mounted, dom_observed: observed.has(panel.id), evidence: 'host-public-panel-runtime' })),
      ...catalog.components.filter(current).map((item) => ({ id: item.id, kind: 'component', label: item.title, owner, slot_id: item.slot,
        path: null, mode: item.mode, mounted: observed.has(item.id), dom_observed: observed.has(item.id), evidence: 'selected-plugin-mounted-anchor' })),
      ...catalog.modules.filter(current).map((item) => ({ id: item.id, kind: 'module', label: item.title, owner,
        slot_id: pageSlotId(item.pluginId, item.route), path: item.route, mode: 'replace', mounted: observed.has(item.id),
        dom_observed: observed.has(item.id), evidence: 'selected-plugin-mounted-anchor' })),
      ...workspaceMounts,
    ];
  }
  function prune(target: ResolvedTarget, entry: AttachedDebug) {
    const found = roots(target);
    const activeElements = new Set(found.map((root) => root.element));
    for (const [id, item] of entry.collectors) {
      if (!activeElements.has(item.collector.root)) {
        item.actions.dispose(); item.collector.dispose(); entry.collectors.delete(id);
      }
    }
    return found;
  }
  function observerFor(target: ResolvedTarget, entry: AttachedDebug, root: ReturnType<typeof roots>[number]) {
    let item = entry.collectors.get(root.id);
    if (!item) {
      let collectors = 0;
      for (const attached of entries()) collectors += attached.collectors.size;
      if (collectors >= 16) return fail('limit_exceeded', '本地最多同时保留16个UI观测器；请结束不再使用的目标会话');
      const owner = { pluginId: target.plugin_id, generation: Number(target.generation) };
      const surface: DebugSurface = { id: root.contribution, kind: root.kind, element: root.element, owner };
      const collector = createUiCollector(root.element, { owner, surfaces: [surface] });
      item = { collector, actions: createDebugActions(collector, { signal: entry.session.signal }) };
      entry.collectors.set(root.id, item);
    }
    return item;
  }
  async function execute(tool: string, target: ResolvedTarget, entry: AttachedDebug | undefined, input: Record<string, unknown>, signal: AbortSignal) {
    if (tool === 'ui_tree' && input.view === 'overview') return json(publicOverview(options, target, slots(target), mountCatalog(target), input));
    const allowed = tool === 'ui_query' ? ['root_id', 'query'] : tool === 'ui_assert' ? ['root_id', 'assertion']
      : tool === 'ui_diff' ? ['root_id', 'before_id', 'after_id'] : tool === 'ui_action' ? ['root_id', 'action'] : ['root_id', 'snapshot_id', 'offset', 'limit'];
    keys(input, allowed);
    const request = tool === 'ui_action' ? object(input.action) : null;
    if (request?.type === 'navigate') {
      if (input.root_id !== undefined) return fail('invalid_parameters', '导航不接受挂载根');
      const parsed = action(request);
      if (parsed.type === 'navigate') return json(await navigate(options, parsed.path, parsed.confirmed === true, signal));
    }
    if (!entry) return fail('capability_unavailable', '所选代次未绑定调试登记表，无法创建本代UI观测器');
    const rootId = input.root_id === undefined ? undefined : text(input.root_id, '挂载根标识');
    const found = prune(target, entry);
    if (request?.type === 'pick') {
      keys(request, ['type']);
      if (rootId && !found.some((root) => root.id === rootId)) return fail('root_unavailable', '指定挂载根不存在');
      if (picking) return fail('pick_in_progress', '已有一次拾取正在等待');
      picking = true;
      try {
        let pickedRoot: string | null = null;
        const matchingRoot = (element: Element) => element.closest('[data-deviceforge-panel][data-deviceforge-plugin], [data-deviceforge-extension][data-deviceforge-plugin]');
        const picked = await pickDocumentOnce(options.document, signal, (element) => {
          const boundary = matchingRoot(element);
          return !rootId || found.some((root) => root.id === rootId && root.element === boundary);
        }, (element) => {
          const boundary = matchingRoot(element);
          const ownerBoundary = element.closest('[data-deviceforge-plugin], [data-deviceforge-plugin-id]');
          if (!ownerBoundary) return hostPick(options, element);
          const pluginId = ownerBoundary.getAttribute('data-deviceforge-plugin') ?? ownerBoundary.getAttribute('data-deviceforge-plugin-id');
          const generation = ownerBoundary.getAttribute('data-deviceforge-generation');
          const runtime = options.manager().diagnosticSnapshot().find((item) => item.id === pluginId && String(item.generation) === generation);
          if (!runtime) return { status: 'indeterminate', target: null, owner: null, reason: '挂载所有者已卸载或换代' };
          const owner = { pluginId: runtime.id, generation: runtime.generation };
          if (pluginId !== target.plugin_id || generation !== target.generation)
            return { status: 'indeterminate', target: null, owner, reason: '已拦截并识别其他插件所有者；须显式选择后才能调试' };
          const root = roots(target).find((item) => item.element === boundary);
          const reference = root ? observerFor(target, entry, root).collector.reference(element) : null;
          pickedRoot = root?.id ?? null;
          return { status: reference ? 'picked' : 'indeterminate', target: reference, owner,
            reason: reference ? '已拦截一次点击，未派发业务动作' : '精确目标不在当前可观测范围' };
        });
        return json({ ...picked, root_id: pickedRoot });
      } finally { picking = false; }
    }
    const rootList = found.map(({ id, kind, contribution }) => ({ root_id: id, kind, contribution_id: contribution }));
    if (!rootId && found.length !== 1) return json({ status: found.length ? 'root_required' : 'not_instantiated',
      reason: found.length ? '多个挂载根必须明确选择root_id' : '当前插件没有已实例化的挂载根；未打开页面不生成UI树', roots: rootList });
    const root = rootId ? found.find((item) => item.id === rootId) : found.at(0);
    if (!root) return fail('root_unavailable', '指定挂载根不存在或已撤销');
    const item = observerFor(target, entry, root);
    const { collector, actions } = item;
    switch (tool) {
      case 'ui_tree': {
        const offset = input.offset === undefined ? 0 : integer(input.offset, '快照偏移', 0, 5000);
        const limit = input.limit === undefined ? 500 : integer(input.limit, '快照页条数', 1, 500);
        if (offset > 0 && input.snapshot_id === undefined) return fail('invalid_parameters', '翻页必须携带snapshot_id，不能重采变化中的DOM');
        const id = input.snapshot_id === undefined ? collector.snapshot().id : text(input.snapshot_id, '快照标识');
        const snapshot = collector.page(id, offset, limit);
        if (!snapshot) return fail('snapshot_unavailable', '快照已过期或不属于当前挂载根，需显式重新采集');
        return json({ root_id: root.id, tree: snapshot });
      }
      case 'ui_query': return json(collector.query(query(input.query)));
      case 'ui_assert': return json(collector.assert(assertion(input.assertion)));
      case 'ui_diff': {
        const beforeId = text(input.before_id, '差异前快照');
        const afterId = text(input.after_id, '差异后快照');
        const diff = collector.diff(beforeId, afterId);
        if (!diff) return fail('snapshot_unavailable', '快照不在同一挂载根观测器的最近缓存中');
        return json(diff);
      }
      case 'ui_action': return json(await actions.execute(action(input.action), signal));
      default: return fail('capability_unavailable', '未知UI工具');
    }
  }
  return { roots: describe, slots, mounts: mountCatalog, execute, prune };
}
