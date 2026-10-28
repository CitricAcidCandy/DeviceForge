import type { HostContext, JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import { array, bounded, createGateway, decodeDirectory, decodeTarget, decodeTree, failure, invocations,
  json, number, object, targetInput, targetKey, text } from './protocol.ts';
import type { DebuggerFailure, Invocation, JsonObject, Target, UiNode, UiTree } from './protocol.ts';
import { nextReportPage } from './report-pages.ts';

export interface EventRow {
  readonly key: string;
  readonly sequence: number;
  readonly target: Target | null;
  readonly sessionId: string;
  readonly level: string;
  readonly label: string;
  readonly logId: string | null;
  readonly raw: JsonValue;
}
export interface DebuggerState {
  readonly open: boolean;
  readonly busy: string | null;
  readonly connected: boolean;
  readonly stale: boolean;
  readonly instanceId: string | null;
  readonly targets: readonly Target[];
  readonly target: Target | null;
  readonly sessionId: string | null;
  readonly sessionState: string;
  readonly capabilities: JsonValue;
  readonly inspection: JsonValue;
  readonly roots: readonly { readonly id: string; readonly label: string }[];
  readonly rootId: string;
  readonly tree: UiTree | null;
  readonly trees: readonly UiTree[];
  readonly selectedNodeId: string;
  readonly queries: readonly string[] | null;
  readonly entries: readonly Invocation[];
  readonly events: readonly EventRow[];
  readonly cursor: number;
  readonly eventGap: boolean;
  readonly droppedEvents: number;
  readonly result: JsonValue;
  readonly report: JsonValue;
  readonly overview: JsonValue;
  readonly installation: JsonValue;
  readonly logs: JsonValue;
  readonly requested: { readonly candidates: readonly { readonly kind: string; readonly pluginId: string }[];
    readonly installationId: string | null } | null;
  readonly error: DebuggerFailure | null;
  readonly notice: string;
  readonly logId: string | null;
}

export function createDebuggerController(context: Pick<HostContext, 'extensions' | 'signal'>) {
  const gateway = createGateway(context);
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const sessions = new Set<string>();
  let request = new AbortController();
  let revision = 0, disposed = false, diagnosticSequence = 0;
  let state: DebuggerState = { open: false, busy: null, connected: false, stale: false, instanceId: null,
    targets: [], target: null, sessionId: null, sessionState: 'none', capabilities: null, inspection: null,
    roots: [], rootId: '', tree: null, trees: [], selectedNodeId: '', queries: null, entries: [], events: [],
    cursor: 0, eventGap: false, droppedEvents: 0, result: null, report: null, overview: null,
    installation: null, logs: null, requested: null, error: null,
    notice: '首次只显示调试入口；打开后连接，明确选择目标后才采集。', logId: null };
  const snapshot = () => state;
  function patch(change: Partial<DebuggerState>) {
    if (disposed) return;
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  function diagnostic(label: string, data: JsonValue, level: string, logId: string | null) {
    const row: EventRow = { key: `local-${++diagnosticSequence}`, sequence: diagnosticSequence,
      target: state.target, sessionId: state.sessionId ?? '', level, label, logId, raw: data };
    patch({ events: [...state.events, row].slice(-500) });
  }
  function scope() {
    request.abort(); request = new AbortController(); revision++;
    return revision;
  }
  const reloadBudget = () => Math.min(120000, Math.max(45000, number(object(state.capabilities).reload_timeout_ms, 50000)));
  async function run(label: string, work: (signal: AbortSignal) => Promise<void>, replace = false, timeoutMs = 15000) {
    if (disposed || context.signal.aborted) return;
    if (state.busy && !replace) { patch({ notice: `正在${state.busy}，可取消当前等待后再操作。` }); return; }
    if (replace) scope();
    const admitted = revision;
    const signal = AbortSignal.any([request.signal, lifetime.signal, context.signal, AbortSignal.timeout(timeoutMs)]);
    patch({ busy: label, error: null });
    try { await bounded(work(signal), signal); }
    catch (error) {
      if (admitted !== revision || disposed) return;
      const problem = failure(error);
      diagnostic(label, { code: problem.code, message: problem.message, unconfirmed: problem.unconfirmed }, 'error', problem.logId);
      patch({ error: problem, logId: problem.logId ?? state.logId,
        notice: problem.unconfirmed ? '结果未确认；请查询状态，独立新操作仍可显式发起。不会自动重放。' : problem.message });
      if (/disconnect|inactive_session|stale_target|target_changed|wrong_instance|stale_generation/.test(problem.code))
        patch({ stale: true, connected: false, sessionState: 'disconnected' });
    } finally { if (!disposed && admitted === revision) patch({ busy: null }); }
  }
  async function tool(name: string, parameters: JsonObject, signal: AbortSignal) {
    const sessionId = state.sessionId;
    if (!sessionId || !state.target) throw new Error('请先明确选择调试目标并打开会话');
    if (state.stale || !state.connected) throw new Error('当前为过期只读快照，请重新连接并核对目标代次');
    const result = await gateway.call(name, { session_id: sessionId, parameters }, signal, name === 'reload' ? reloadBudget() : 15000);
    signal.throwIfAborted();
    patch({ logId: result.logId ?? state.logId });
    return result.data;
  }
  function applyTree(value: unknown, append = false) {
    const response = object(value), tree = decodeTree(response.tree);
    if (!tree) {
      const roots = array(response.roots).map((raw) => ({ id: text(object(raw).root_id),
        label: text(object(raw).contribution_id) })).filter((root) => root.id);
      patch({ notice: text(response.reason, '当前目标未提供可读取的 UI 树'), ...(roots.length ? { roots } : {}) });
      return;
    }
    const previous = state.tree;
    const merged = append && previous?.id === tree.id
      ? { ...tree, nodes: [...new Map([...previous.nodes, ...tree.nodes].map((node) => [node.id, node])).values()] } : tree;
    patch({ tree: merged, trees: [...state.trees.filter((item) => item.id !== merged.id), merged].slice(-10),
      rootId: text(response.root_id, state.rootId), stale: false, queries: null,
      selectedNodeId: merged.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : '',
      notice: '已读取观测结构；可观测不等于可插入，DOM 存在不证明像素可见或业务成功。' });
  }
  function mergeQueryNodes(value: unknown) {
    const current = state.tree;
    if (!current) return;
    const found = decodeTree({ id: current.id, observedAt: current.observedAt, nodes: array(object(value).nodes) });
    if (found) patch({ tree: { ...current, nodes: [...new Map([...current.nodes, ...found.nodes].map((node) => [node.id, node])).values()] } });
  }
  async function inspect(signal: AbortSignal, collectTree: boolean) {
    const data = await tool('inspect', {}, signal);
    const inspection = object(data);
    const roots = array(inspection.roots).map((raw) => ({ id: text(object(raw).root_id),
      label: text(object(raw).contribution_id) })).filter((root) => root.id);
    patch({ inspection: data, entries: invocations(data), roots,
      rootId: roots.some((root) => root.id === state.rootId) ? state.rootId : roots.length === 1 ? roots[0]?.id ?? '' : '',
      notice: roots.length > 1 ? '此目标有多个挂载根，请明确选择一个后读取 UI 树。' : '已检查公开目录与代次。' });
    if (collectTree && state.target?.kind === 'browser' && roots.length === 1)
      applyTree(await tool('ui_tree', { root_id: roots[0]?.id ?? '' }, signal));
  }
  async function directory(signal: AbortSignal) {
    const response = await gateway.call('targets', {}, signal);
    signal.throwIfAborted(); patch({ targets: decodeDirectory(response.data), logId: response.logId ?? state.logId });
  }
  async function closeSession(id: string, signal: AbortSignal) {
    await gateway.call('session', { action: 'close', session_id: id }, signal);
    signal.throwIfAborted(); sessions.delete(id);
  }
  async function select(target: Target) {
    await run('切换目标', async (signal) => {
      const previous = state.sessionId;
      patch({ target, sessionId: null, sessionState: 'opening', tree: null, trees: [], inspection: null,
        roots: [], rootId: '', entries: [], selectedNodeId: '', queries: null, cursor: 0, result: null,
        report: null, stale: false, notice: '正在打开明确选定目标的调试会话' });
      if (previous) await closeSession(previous, signal);
      const response = await gateway.call('session', { action: 'open', target: targetInput(target) }, signal);
      const session = object(response.data), id = text(session.session_id);
      if (id) sessions.add(id);
      signal.throwIfAborted();
      if (!id || session.state !== 'active') throw new Error('宿主没有返回有效活动会话');
      const actual = decodeTarget(session.target);
      if (!actual || targetKey(actual) !== targetKey(target)) throw new Error('会话身份与明确选定目标不一致');
      patch({ sessionId: id, sessionState: 'active', connected: true, logId: response.logId });
      await inspect(signal, true);
    }, true);
  }
  async function checkConnection() {
    if (disposed || state.busy || !state.open) return;
    await run('核对连接', async (signal) => {
      const response = await gateway.service('status', {}, signal);
      signal.throwIfAborted();
      const capabilities = object(response.data), bridge = object(capabilities.bridge);
      const bridgeId = text(bridge.instanceId) || text(bridge.instance_id);
      const connected = bridge.state === 'connected';
      patch({ capabilities: response.data });
      const usesCurrentBridge = !state.target || (state.target.kind === 'browser' && state.target.instanceId === state.instanceId);
      if (usesCurrentBridge && (!connected || bridgeId !== state.instanceId)) {
        patch({ connected: false, stale: true, sessionState: 'disconnected', notice: text(bridge.reason,
          '连接已断开或实例已更换；保留最后快照，只读查看，不自动重放。') }); return;
      }
      if (state.sessionId) {
        const session = await gateway.call('session', { action: 'get', session_id: state.sessionId }, signal);
        signal.throwIfAborted();
        const current = object(session.data), target = decodeTarget(current.target);
        if (current.state !== 'active' || !target || !state.target || targetKey(target) !== targetKey(state.target)) {
          patch({ stale: true, connected: false, sessionState: text(current.state, 'target_changed'),
            notice: '会话或目标代次已改变，最后快照已过期；请明确重新选择当前目标。' });
        }
      }
    });
  }
  async function open() {
    patch({ open: true });
    await run('连接调试桥', async (signal) => {
      const capabilities = await gateway.service('capabilities', {}, signal);
      signal.throwIfAborted(); patch({ capabilities: capabilities.data });
      const start = await gateway.service('start', {}, signal);
      signal.throwIfAborted();
      const instanceId = text(object(start.data).instance_id);
      if (!instanceId) throw new Error('调试桥未返回当前实例标识');
      patch({ instanceId, connected: true, notice: '已连接当前浏览器实例，请明确选择浏览器插件或服务器插件。' });
      await directory(signal);
    });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; request.abort(); lifetime.abort(); listeners.clear();
    context.signal.removeEventListener('abort', dispose);
    const wait = AbortSignal.timeout(2000);
    const closing = [...sessions].map((sessionId) => gateway.call('session', { action: 'close', session_id: sessionId }, wait));
    sessions.clear();
    return bounded(Promise.allSettled(closing), wait).then(() => undefined, () => undefined);
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) void dispose();
  return {
    snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open,
    collapse() { patch({ open: false }); },
    cancel() { scope(); patch({ busy: null, notice: '已取消当前等待；已派发副作用结果未确认，不会自动重放。' }); },
    select,
    checkConnection,
    refreshTargets: () => run('刷新目标目录', directory),
    async requestTargets(candidates: readonly { readonly kind: string; readonly pluginId: string }[], installationId: string | null = null) {
      if (!candidates.length) return;
      patch({ requested: { candidates, installationId }, open: true });
      if (!state.instanceId) await open();
      else await run('带入市场目标', directory, true);
      patch({ notice: `市场已带入 ${candidates.length} 个候选组件，请核对实例、组件和代次后明确选择。` });
    },
    clearRequested() { patch({ requested: null }); },
    reconnect: (confirmed: boolean) => run('显式重新连接', async (signal) => {
      if (!confirmed) throw new Error('重连将创建新浏览器实例，请先明确确认');
      const response = await gateway.service('reconnect', { input: { confirmed } }, signal);
      signal.throwIfAborted();
      const instanceId = text(object(response.data).instance_id);
      if (!instanceId || instanceId === state.instanceId) throw new Error('重连尚未返回不同的新实例，请核对桥状态');
      patch({ instanceId, connected: true, stale: Boolean(state.tree), sessionState: 'disconnected',
        notice: '新实例已建立；旧快照仍过期。请明确选择当前插件新代，会话与原动作不自动重放。' });
      await directory(signal);
    }, true),
    installation: () => run('查询安装与运行修订', async (signal) => {
      const response = await gateway.service('installation', {}, signal);
      signal.throwIfAborted(); patch({ installation: response.data, logId: response.logId });
    }),
    logs: (query: string, byId: boolean) => run('搜索服务器公共日志', async (signal) => {
      const input: JsonObject = { order: 'desc', ...(byId ? { log_id: query.trim() } : { q: query.trim() }) };
      const response = await gateway.service('logs', { input }, signal);
      signal.throwIfAborted(); patch({ logs: response.data, logId: response.logId,
        notice: object(response.data).limited === true ? '日志搜索已受限截断；结果不是完整日志。' : '已读取服务器公共日志。' });
    }),
    refreshInspection: () => run('检查目标', (signal) => inspect(signal, false)),
    async close() {
      await run('关闭调试会话', async (signal) => {
        if (state.sessionId) await closeSession(state.sessionId, signal);
        patch({ open: false, sessionId: null, sessionState: 'closed', stale: Boolean(state.tree),
          notice: '调试会话已关闭；业务插件与任务继续由原入口管理。' });
      }, true);
    },
    setRoot(id: string) {
      if (!state.roots.some((root) => root.id === id)) return;
      scope(); patch({ rootId: id, tree: null, trees: [], selectedNodeId: '', queries: null, busy: null });
    },
    setNode(id: string) { if (state.tree?.nodes.some((node) => node.id === id)) patch({ selectedNodeId: id }); },
    tree: () => run('读取 UI 树', async (signal) => {
      if (state.roots.length > 1 && !state.rootId) throw new Error('请先明确选择挂载根');
      applyTree(await tool('ui_tree', state.rootId ? { root_id: state.rootId } : {}, signal));
    }),
    nextTreePage: () => run('读取下一页节点', async (signal) => {
      const tree = state.tree, page = object(object(tree?.raw).page);
      if (!tree || typeof page.nextOffset !== 'number') return;
      applyTree(await tool('ui_tree', { root_id: state.rootId, snapshot_id: tree.id, offset: page.nextOffset, limit: 500 }, signal), true);
    }),
    overview: (offset = 0) => run('读取公开挂载目录', async (signal) => {
      const data = await tool('ui_tree', { view: 'overview', offset, limit: 100 }, signal);
      patch({ overview: data, notice: '公开目录不代表页面已实例化；未挂载条目不生成 DOM 树。' });
    }),
    query: (query: JsonValue) => run('语义查询', async (signal) => {
      const data = await tool('ui_query', { root_id: state.rootId, query }, signal);
      mergeQueryNodes(data);
      patch({ queries: array(object(data).nodes).map((node) => text(object(node).id)), result: data,
        notice: text(object(data).reason, '语义查询已完成；不完整观测不能证明节点不存在。') });
    }),
    clearQuery() { patch({ queries: null }); },
    navigate: (path: string, confirmed: boolean) => run('导航到公开路由', async (signal) => {
      if (!confirmed) throw new Error('导航需要本次显式确认');
      const data = await tool('ui_action', { action: { type: 'navigate', path, confirmed } }, signal);
      patch({ result: data, notice: text(object(data).reason, '已请求导航，未证明页面或业务完成。') });
    }),
    assertion: (assertion: JsonValue) => run('执行结构断言', async (signal) => {
      const data = await tool('ui_assert', { root_id: state.rootId, assertion }, signal);
      patch({ result: data, notice: `断言 ${text(object(data).status, '结果未知')}：${text(object(data).reason)}` });
    }),
    diff: (before: string, after: string) => run('比较快照', async (signal) => {
      const data = await tool('ui_diff', { root_id: state.rootId, before_id: before, after_id: after }, signal);
      patch({ result: data, notice: text(object(data).reason, '已比较选定挂载根的两个快照。') });
    }),
    action: (type: string, node: UiNode | null, value: string, confirmed: boolean, allowUnknown: boolean) =>
      run(type === 'pick' ? '拾取节点（Esc 取消）' : '执行节点动作', async (signal) => {
        if (type !== 'pick' && !node) throw new Error('请先选择当前快照中的节点');
        if (type !== 'highlight' && type !== 'pick' && (!confirmed || !allowUnknown))
          throw new Error('请分别确认本次动作和未知副作用；可能间接影响设备');
        const action: JsonObject = type === 'pick' ? { type } : { type, confirmed, allowUnknownSideEffects: allowUnknown };
        if (node && type !== 'pick') action.target = { id: node.id, generation: node.generation, revision: node.revision };
        if (type === 'fill') action.value = value;
        if (type === 'select') action.values = value.split('\n').filter(Boolean);
        const data = await tool('ui_action', { ...(state.rootId && type !== 'pick' ? { root_id: state.rootId } : {}), action }, signal);
        patch({ result: data, notice: text(object(data).reason, '已收到节点动作回执；业务结果仍需核对。') });
        diagnostic(`节点动作 ${type}`, data, 'info', state.logId);
        if (type === 'pick') {
          const picked = object(data), owner = object(picked.owner), ref = object(picked.target);
          if (picked.status === 'picked' && owner.pluginId === state.target?.pluginId &&
              String(owner.generation) === state.target?.generation) {
            const rootId = text(picked.root_id);
            if (rootId) patch({ rootId });
            applyTree(await tool('ui_tree', rootId ? { root_id: rootId } : {}, signal));
            if (!state.tree?.nodes.some((item) => item.id === ref.id) && text(ref.id)) {
              const found = await tool('ui_query', { root_id: state.rootId, query: { id: text(ref.id), limit: 1 } }, signal);
              mergeQueryNodes(found);
            }
            if (state.tree?.nodes.some((item) => item.id === ref.id)) patch({ selectedNodeId: text(ref.id) });
          } else if (picked.source === 'host-dom') patch({ selectedNodeId: '',
            notice: '已拾取宿主普通节点，仅展示只读身份；普通节点不能作为插件动作目标或插入槽位。' });
          else if (picked.status === 'picked') patch({ notice: '拾取到其他插件，仅展示归属；请明确切换目标后再查看。' });
        }
      }),
    invoke: (entry: Invocation, input: JsonValue, confirmed: boolean, allowUnknown: boolean, includeResult = false) =>
      run('试调用公开入口', async (signal) => {
        if (!state.entries.some((item) => item.key === entry.key) || !entry.available) throw new Error('调用入口不在当前目标目录中');
        if (!confirmed || !allowUnknown) throw new Error('试调用需要分别确认本次调用和未知副作用');
        const parameters: JsonObject = { kind: entry.kind, id: entry.id, input, confirmed,
          allow_unknown_side_effects: allowUnknown };
        if (state.target?.kind === 'browser') parameters.include_result = includeResult;
        if (entry.version) parameters.version = entry.version;
        const data = await tool('invoke', parameters, signal);
        patch({ result: data, notice: '已收到调用回执；已接受或已派发不代表原业务完成，请核对原任务。' });
        diagnostic(`试调用 ${entry.id}`, data, 'info', state.logId);
      }),
    reload: (confirmed: boolean) => run('重载选定插件', async (signal) => {
      const target = state.target;
      if (!target || !confirmed) throw new Error('请明确确认当前插件 ID 和代次后重载');
      const data = await tool('reload', { confirmed: true }, signal);
      patch({ result: data }); diagnostic('插件重载', data, 'info', state.logId);
      await directory(signal);
      const next = state.targets.find((item) => item.kind === target.kind && item.instanceId === target.instanceId && item.pluginId === target.pluginId);
      patch({ stale: true, sessionState: 'target_changed',
        notice: next?.generation && next.generation !== target.generation
          ? `已核到新代 ${next.generation}；请明确选择新代后继续观测，不重放原动作。`
          : '尚未核到不同的新代；请刷新目标目录检查结果，不自动重载或重放。' });
    }, false, reloadBudget()),
    events: () => run('读取下一页事件', async (signal) => {
      const sessionId = state.sessionId;
      if (!sessionId) throw new Error('请先选择调试会话；断线时可查看已缓存历史');
      const response = await gateway.call('events', { session_id: sessionId, after: state.cursor, limit: 100 }, signal);
      signal.throwIfAborted();
      const page = object(response.data);
      const rows: EventRow[] = array(page.events).map((raw) => {
        const event = object(raw), status = text(event.command_state) || text(event.session_state);
        return { key: `${sessionId}:${number(event.sequence)}`, sequence: number(event.sequence),
          target: state.target, sessionId, level: /failed|unconfirmed|disconnected/.test(status) ? 'error' : 'info',
          label: `${text(event.kind)} ${status}`.trim(), logId: text(event.log_id) || response.logId,
          raw: json(raw) };
      });
      const events = [...new Map([...state.events, ...rows].map((row) => [row.key, row])).values()].slice(-500);
      patch({ events, cursor: number(page.next_after, state.cursor), eventGap: page.gap === true,
        droppedEvents: number(page.dropped_events), logId: response.logId,
        notice: page.gap === true ? '事件游标存在缺口；请保留截断提示，不据此推断没有发生事件。' : '事件分页已更新。' });
    }),
    report: (persist = false, format: 'json' | 'markdown' = 'json') => run('汇总调试报告', async (signal) => {
      const data = await tool('report', { export: persist ? format : 'none' }, signal);
      patch({ report: data, notice: object(data).artifact ? '宿主已返回报告产物；可通过公开产物入口下载。'
        : '已汇总内存证据，可下载本地 JSON / Markdown；不是完整生产验收。' });
    }),
    reportNext: () => run('读取报告快照续页', async (signal) => {
      const current = object(state.report), continuation = nextReportPage(state.report);
      if (!continuation) throw new Error('报告没有可读取的快照续页');
      const data = await tool('ui_tree', { root_id: continuation.rootId, snapshot_id: continuation.snapshotId, offset: continuation.offset, limit: 500 }, signal);
      const page = object(data);
      if (!decodeTree(page.tree)) throw new Error('报告快照续页未返回有效结构树');
      patch({ report: json({ ...current, ui_snapshot_pages: [...array(current.ui_snapshot_pages), page] }),
        notice: '已读取指定快照续页；报告仍保留分页与不完整观测说明。' });
    }),
    dispose,
  };
}
export type DebuggerController = ReturnType<typeof createDebuggerController>;
