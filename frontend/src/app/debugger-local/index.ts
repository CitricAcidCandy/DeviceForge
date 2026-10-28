import type { LocalDebugger, LocalDebuggerOptions, AttachedDebug, ResolvedTarget } from './types.ts';
import { createAttachment, resetSession } from './attachment.ts';
import { createLocalUi, clearCollectors } from './ui.ts';
import { invoke, ownedCatalog, reload } from './invocation.ts';
import { fail, json, keys, object, target, unavailable } from './validation.ts';
import { localReport } from './report.ts';
export type { LocalDebugger, LocalDebuggerOptions, DebugTarget, HostDebugRoute, ResolvedTarget } from './types.ts';

export function createLocalDebugger(options: LocalDebuggerOptions): LocalDebugger {
  const attachments = new Map<string, AttachedDebug>();
  const selected = new Map<string, string>();
  const sessions = new Map<string, AbortController>();
  const ui = createLocalUi(options, () => attachments.values());
  const lifetime = new AbortController();
  const reloading = new Set<string>();
  let disposed = false;
  let inFlight = 0;
  if ((options.slots?.length ?? 0) > 128) fail('limit_exceeded', '公开槽位目录最多128项');

  function active() {
    if (disposed || options.signal.aborted) fail('disposed', '本地调试装配已关闭');
  }
  function resolve(value: unknown): ResolvedTarget {
    const input = target(value);
    const runtime = options.manager().diagnosticSnapshot().find((item) => item.id === input.plugin_id);
    if (!runtime) return fail('target_unavailable', '插件没有当前浏览器运行实例');
    const current = String(runtime.generation);
    if (input.generation !== null && input.generation !== current) return fail('stale_generation', '插件代次已变化');
    return { plugin_id: input.plugin_id, generation: current };
  }
  function entryFor(current: ResolvedTarget) {
    const entry = attachments.get(current.plugin_id);
    return entry?.generation === current.generation && !entry.lifetime.signal.aborted ? entry : undefined;
  }
  function inspect(current: ResolvedTarget) {
    const runtime = options.manager().diagnosticSnapshot().find((item) => item.id === current.plugin_id);
    const entry = entryFor(current);
    const snapshot = entry?.registry.snapshot();
    return {
      target: current, runtime: runtime ?? null, roots: ui.roots(current), slot_catalog: ui.slots(current), mount_catalog: ui.mounts(current),
      catalog: ownedCatalog(options, current),
      cleanup_history: options.manager().cleanupSnapshot().filter((item) => item.id === current.plugin_id)
        .map((item) => ({ plugin_id: item.id, generation: String(item.generation), state: 'cleanup_failed',
          message: '该代资源回收未完整确认，保留历史告警；不据此封锁本代独立调用', raw_error_included: false })),
      debug: snapshot ? { ...snapshot, events: snapshot.events.filter((event) => event.sequence > (entry?.eventFloor ?? 0)) } : null,
      lifecycle: entry?.lifecycle ?? [], registration_failures: entry?.registrationFailures ?? 0,
      capabilities: { inspect: true, ui_tree: true, ui_query: true, ui_assert: true, ui_diff: true,
        ui_action: true, invoke: true, reload: true, report: true, navigate: !!options.navigate && !!options.readHostRoutes,
        pick: true, persistent_reports: false,
        supported_ui_actions: ['highlight', 'click', 'fill', 'select', 'scroll', 'wait', 'pick',
          ...(options.navigate && options.readHostRoutes ? ['navigate'] : [])],
        layout_measurement: true, public_overview: true,
        pixel_visibility: false, framework_state: false, arbitrary_evaluation: false },
      coverage: '仅当前明确选择的插件代次；没有主动打开页面、扫描其他插件或执行设备动作',
      privacy: '脱敏覆盖已知敏感字段和Bearer模式，不能保证识别自由文本中的所有秘密',
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener('abort', dispose);
    lifetime.abort(); selected.clear();
    for (const session of sessions.values()) session.abort();
    sessions.clear();
    for (const entry of [...attachments.values()]) {
      clearCollectors(entry); entry.lifetime.abort();
      void entry.registry.dispose().catch(() => {});
    }
    attachments.clear();
  }
  options.signal.addEventListener('abort', dispose, { once: true });
  if (options.signal.aborted) dispose();

  return {
    attach(pluginId, value, scope) {
      active();
      const parsed = target({ plugin_id: pluginId, generation: value });
      const currentGeneration = resolve(parsed).generation;
      if (scope.context.signal.aborted) return fail('stale_generation', '不能绑定已关闭的插件作用域');
      const previous = attachments.get(pluginId);
      if (previous?.generation === currentGeneration) return previous.access;
      if (previous) { previous.lifetime.abort(); void previous.registry.dispose().catch(() => {}); }
      if (attachments.size >= 128) return fail('limit_exceeded', '调试登记最多128个插件实例');
      const entry = createAttachment(pluginId, currentGeneration, scope, options.signal,
        () => !disposed && selected.get(pluginId) === currentGeneration,
        (closing) => { if (attachments.get(pluginId) === closing) attachments.delete(pluginId); });
      if (!entry.lifetime.signal.aborted && !scope.context.signal.aborted) attachments.set(pluginId, entry);
      return entry.access;
    },
    observe(event) {
      try {
        if (disposed || selected.get(event.pluginId) !== String(event.generation) || !Number.isFinite(event.at)) return;
        const entry = attachments.get(event.pluginId);
        if (!entry || entry.generation !== String(event.generation)) return;
        entry.lifecycle.push({ pluginId: event.pluginId, generation: event.generation, stage: event.stage, at: event.at });
        if (entry.lifecycle.length > 200) entry.lifecycle.shift();
      } catch { /* 生命周期观测不得影响插件装卸。 */ }
    },
    directory() {
      active();
      return options.manager().diagnosticSnapshot().map((item) => ({ plugin_id: item.id,
        generation: String(item.generation), version: item.version }));
    },
    select(targets) {
      active();
      if (!Array.isArray(targets) || targets.length > 64) return fail('limit_exceeded', '调试最多明确选择64个目标');
      const next = new Map<string, string>();
      for (const candidate of targets) {
        const current = resolve(json(candidate));
        if (next.has(current.plugin_id)) return fail('invalid_parameters', '不能重复选择同一插件');
        next.set(current.plugin_id, current.generation);
      }
      for (const entry of attachments.values()) {
        if (selected.get(entry.pluginId) !== next.get(entry.pluginId)) resetSession(entry);
      }
      for (const [id, session] of sessions) {
        if (selected.get(id) !== next.get(id)) { session.abort(); sessions.delete(id); }
      }
      for (const id of next.keys()) if (!sessions.has(id)) sessions.set(id, new AbortController());
      selected.clear();
      for (const [id, value] of next) selected.set(id, value);
    },
    async execute(tool, value, parameters, caller) {
      active();
      const current = resolve(json(value));
      if (selected.get(current.plugin_id) !== current.generation) return fail('target_not_selected', '必须先显式选择当前插件代次');
      if (inFlight >= 4) return fail('limit_exceeded', '本地调试最多4项在途，不隐式排队或重放');
      const input = object(json(parameters));
      const entry = entryFor(current);
      const sessionSignal = sessions.get(current.plugin_id)?.signal;
      const selectionSignal = AbortSignal.any([caller, options.signal, lifetime.signal, ...(sessionSignal ? [sessionSignal] : [])]);
      const reloadSignal = AbortSignal.any([caller, options.signal, lifetime.signal]);
      const signal = AbortSignal.any([selectionSignal, ...(entry ? [entry.session.signal] : [])]);
      signal.throwIfAborted();
      inFlight++;
      try {
        let result;
        if (tool === 'inspect' || tool === 'report') {
          if (tool === 'inspect') keys(input, []);
          if (entry) ui.prune(current, entry);
          const evidence = inspect(current);
          result = tool === 'report' ? localReport(current, entry, evidence, input) : evidence;
        } else if (['ui_tree', 'ui_query', 'ui_assert', 'ui_diff', 'ui_action'].includes(tool)) {
          result = await ui.execute(tool, current, entry, input, signal);
        } else if (tool === 'invoke') {
          const mutationSignal = AbortSignal.any([signal, ...(entry ? [entry.scope.context.signal] : [])]);
          result = await invoke(options, current, input, mutationSignal);
        } else if (tool === 'reload') {
          if (reloading.has(current.plugin_id)) return fail('reload_in_progress', '该插件重载尚在等待，不重复派发');
          reloading.add(current.plugin_id);
          try {
            // 重载期间旧目标、会话和作用域都会撤销，等待只绑定调用方与宿主生命周期。
            result = await reload(options, current, input, reloadSignal);
          } finally { reloading.delete(current.plugin_id); }
        } else return unavailable('此本地调试工具尚未实现');
        if (tool !== 'reload') {
          signal.throwIfAborted();
          const latest = resolve(current);
          if (selected.get(latest.plugin_id) !== latest.generation) return fail('target_not_selected', '结果返回前目标选择已撤销');
        }
        if (entry && (tool === 'invoke' || tool === 'ui_action')) {
          // 关联只进入当前目标的事件环，绝不复制填写值、调用输入或完整输出。
          const record = object(json(result, true));
          entry.access.emit({ name: `debugger.${tool}`, metadata: { tool,
            ...(typeof record.status === 'string' ? { status: record.status } : {}),
            ...(typeof record.logId === 'string' ? { log_id: record.logId } : {}) } });
        }
        return json(result, true);
      } finally { inFlight--; }
    },
    dispose,
  };
}
