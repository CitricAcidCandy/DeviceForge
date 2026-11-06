import { ApiError, isDebuggerBatch, isDebuggerCommandResult, isDebuggerReceipt, isDebuggerStatus } from '../../../services/api/index.ts';
import type { DebuggerAckDto, DebuggerStatusDto } from '../../../services/api/index.ts';
import type { components } from '../../../services/api/generated.ts';
import { readRealtimeEnvelope } from '../../../services/realtime/index.ts';
import type { RealtimeChannel } from '../../../services/realtime/index.ts';
import { isJsonData } from '../../../shared/jobs/index.ts';
import { HostError } from '../../../plugin-sdk/index.ts';
import type { BridgeCommand, DebuggerBridgeOptions, DebuggerBridgeSnapshot } from '../types/index.ts';
import { bounded } from '../utils/wait.ts';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type OpenResult = components['schemas']['DebuggerBridgeOpened'];
type OpenInput = components['schemas']['DebuggerBridgeOpen'];
function opened(value: unknown): value is OpenResult {
  return object(value) && typeof value.instance_id === 'string' && typeof value.resume_key === 'string' &&
    value.resume_key.length <= 128 && isDebuggerStatus(value.status) && Array.isArray(value.commands) &&
    value.commands.length <= 4 && value.commands.every(isDebuggerCommandResult);
}

/** 传输重连保留本页执行记录，只补交结果，不再次执行已交付命令。 */
export function createSocketDebuggerBridge(options: DebuggerBridgeOptions, channel: RealtimeChannel) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const seen = new Set<string>();
  const inflight = new Map<string, { instanceId: string | null; work: Promise<void> }>();
  const receipts = new Map<string, DebuggerAckDto>();
  const releases: (() => void)[] = [];
  let instanceId: string | null = null, resumeKey: string | null = null;
  let state: DebuggerBridgeSnapshot['state'] = 'idle';
  let activeSessions = 0, unconfirmedReceipts = 0;
  let reason: string | null = null, directory = '';
  let generation = 0, registering: Promise<void> | null = null;
  let started: Promise<void> | null = null, closing: Promise<void> | null = null;
  let startedReady: (() => void) | null = null;
  let flushing: Promise<void> | null = null, updating = false, dirty = false;
  let needsOpen = false, flushAgain = false;
  let registerGeneration = -1;
  let connectionScope = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryUntil = 0, retryAttempt = 0;
  const budget = (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  const controlBudget = () => AbortSignal.any([budget(5000), connectionScope.signal]);
  const current = (epoch: number) => epoch === generation && !signal.aborted;
  function cancelRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }
  function select(status: DebuggerStatusDto) {
    if (status.instance_id !== instanceId) throw new Error('调试状态属于另一浏览器实例');
    const plugins = options.directory();
    const selected = status.active_sessions.filter(session => session.state === 'active');
    activeSessions = selected.length;
    options.select(selected.map(session => session.target).filter(target => plugins.some(plugin =>
      plugin.plugin_id === target.plugin_id && plugin.generation === target.generation)));
  }
  function failed(error: unknown, epoch = generation) {
    if (!current(epoch)) return;
    state = 'disconnected';
    reason = error instanceof ApiError || error instanceof HostError ? error.message
      : '调试通道暂不可用，普通业务仍可继续；原动作不会自动重放';
    if (!channel.connected() || retryTimer) return;
    retryUntil ||= Date.now() + 60000;
    const remaining = retryUntil - Date.now();
    if (remaining <= 0) return;
    const delay = Math.min(remaining, Math.min(5000, Math.max(500,
      500 * 2 ** Math.min(retryAttempt++, 4) * (0.8 + Math.random() * 0.4))));
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, delay);
  }
  async function ready() {
    if (!instanceId || state !== 'connected' || !channel.connected()) return;
    await channel.request('bridge:ready', { instance_id: instanceId,
      limit: Math.max(0, 4 - inflight.size - receipts.size) }, controlBudget());
  }
  function flush(): Promise<void> {
    flushAgain = true;
    if (flushing) return flushing;
    flushing = (async () => {
      while (flushAgain && state === 'connected' && !signal.aborted) {
        flushAgain = false;
        const epoch = generation;
        for (const [id, receipt] of [...receipts]) {
          if (!channel.connected() || signal.aborted || receipt.instance_id !== instanceId) return;
          try {
            const result = await channel.request('bridge:ack', receipt, controlBudget());
            if (!current(epoch)) return;
            if (!isDebuggerReceipt(result) || result.command_id !== id) throw new Error('调试回执编号不一致');
            if (receipts.get(id) === receipt) receipts.delete(id);
          } catch (error) {
            if (!current(epoch)) return;
            // 已明确进入终态的回执不再补交；未知发送保留到重连核对。
            if (error instanceof ApiError && ['debugger_receipt_expired', 'debugger_duplicate_receipt'].includes(error.code))
              receipts.delete(id);
            unconfirmedReceipts++; failed(error, epoch); return;
          }
        }
        if (!current(epoch)) return;
        try { await ready(); } catch (error) { if (current(epoch)) failed(error, epoch); return; }
      }
    })().catch(error => failed(error)).finally(() => {
      flushing = null;
      if (flushAgain && state === 'connected' && !signal.aborted) void flush();
    });
    return flushing;
  }
  async function execute(command: BridgeCommand) {
    const currentId = instanceId;
    const timeout = Math.max(1, Math.min(command.remaining_ms,
      command.tool === 'reload' || command.tool === 'automation_run' ? 30000 : 10000));
    const current = budget(timeout);
    let success = false, response: unknown;
    try {
      if (!command.remaining_ms) throw new Error('命令交付时已到期');
      response = await bounded(Promise.resolve().then(() => options.execute(command, current)), current);
      if (!isJsonData(response) || new TextEncoder().encode(JSON.stringify(response)).length > 1024 * 1024)
        throw new Error('调试结果超过公开结构或大小限制');
      success = true;
    } catch (error) {
      const controlled = error instanceof HostError && error.code.startsWith('debugger_') ? error : null;
      response = { error: { code: current.aborted ? 'debugger_result_unconfirmed' : controlled?.code ?? 'debugger_action_failed',
        message: current.aborted ? '调试等待已结束，实际动作结果仍需核对，不会自动重放'
          : controlled?.message ?? '本次调试无法确认，请检查目标状态，未自动重放' } };
    }
    if (!isJsonData(response)) response = null;
    if (!currentId || signal.aborted || instanceId !== currentId) { unconfirmedReceipts++; return; }
    receipts.set(command.command_id, { instance_id: currentId, command_id: command.command_id,
      plugin_id: command.target.plugin_id, generation: command.target.generation ?? null, success, response });
  }
  function receive(value: unknown) {
    try {
      const batch = readRealtimeEnvelope(value);
      if (!isDebuggerBatch(batch)) throw new Error('调试推送消息不符合当前契约');
      if (state !== 'connected' || signal.aborted) return;
      select(batch);
      for (const command of batch.commands) {
        if (command.target.instance_id !== instanceId || seen.has(command.command_id)) continue;
        if (seen.size >= 4096 || inflight.size + receipts.size >= 4) throw new Error('调试实例达到本地命令上限');
        seen.add(command.command_id);
        const work = execute(command);
        inflight.set(command.command_id, { instanceId, work });
        void work.catch(failed).finally(() => {
          inflight.delete(command.command_id); void flush();
        });
      }
    } catch (error) { if (!connectionScope.signal.aborted) failed(error); }
  }
  async function open() {
    if (signal.aborted || !channel.connected()) return;
    const epoch = generation;
    state = 'connecting';
    const plugins = [...options.directory()];
    const known = [...new Set([...inflight].filter(([, entry]) => entry.instanceId === instanceId).map(([id]) => id)
      .concat([...receipts.keys()]))];
    const input: OpenInput = { instance_id: instanceId, resume_key: resumeKey, plugins, inflight: known };
    let value: unknown;
    try {
      value = await channel.request('bridge:open', input, controlBudget());
    } catch (error) {
      if (!current(epoch)) return;
      if (!(error instanceof ApiError) || !instanceId ||
          !['debugger_not_found', 'debugger_resume_expired', 'debugger_session_inactive'].includes(error.code)) throw error;
      // 宿主重启或实例过期后建立新身份，不把原命令搬入新实例。
      unconfirmedReceipts += inflight.size + receipts.size;
      receipts.clear(); options.select([]); instanceId = null; resumeKey = null;
      value = await channel.request('bridge:open', { instance_id: null, resume_key: null, plugins, inflight: [] } satisfies OpenInput,
        controlBudget());
    }
    if (signal.aborted || epoch !== generation || !channel.connected()) return;
    if (!opened(value) || value.status.instance_id !== value.instance_id) throw new Error('调试登记响应不符合当前契约');
    instanceId = value.instance_id; resumeKey = value.resume_key;
    directory = JSON.stringify(plugins); state = 'connected'; reason = null;
    select(value.status);
    for (const result of value.commands) {
      if (!['queued', 'delivered'].includes(result.state)) receipts.delete(result.command_id);
    }
    await flush();
    await directoryChanged();
    if (current(epoch) && state === 'connected') {
      cancelRetry(); retryUntil = 0; retryAttempt = 0; startedReady?.();
    }
  }
  function connect(): Promise<void> {
    if (registering && registerGeneration === generation) return registering;
    needsOpen = true;
    if (registering) return registering;
    registering = (async () => {
      while (needsOpen && !signal.aborted && channel.connected()) {
        needsOpen = false;
        const epoch = generation;
        registerGeneration = epoch;
        try { await open(); } catch (error) { failed(error, epoch); }
      }
    })().finally(() => {
      registering = null;
      if (needsOpen && !signal.aborted && channel.connected()) void connect();
    });
    return registering;
  }
  async function directoryChanged() {
    dirty = true;
    if (updating || state !== 'connected' || !instanceId) return;
    updating = true;
    const updateEpoch = generation;
    try {
      while (dirty && state === 'connected' && instanceId && !signal.aborted) {
        dirty = false;
        const epoch = generation;
        const plugins = [...options.directory()], next = JSON.stringify(plugins);
        if (next === directory) continue;
        const value = await channel.request('bridge:directory', { instance_id: instanceId, plugins }, controlBudget());
        if (!current(epoch)) return;
        if (!isDebuggerStatus(value)) throw new Error('调试插件目录响应无效');
        select(value); directory = next;
      }
    } catch (error) { failed(error, updateEpoch); }
    finally {
      updating = false;
      if (dirty && state === 'connected' && !signal.aborted) void directoryChanged();
    }
  }
  function start(): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('调试通道已关闭'));
    if (state === 'connected') return Promise.resolve();
    if (started) return state === 'disconnected' ? Promise.reject(new Error(reason ?? '实时调试通道正在恢复')) : started;
    state = 'connecting';
    releases.push(channel.on('bridge:batch', receive), channel.subscribe(next => {
      if (next.state === 'ready') {
        if (connectionScope.signal.aborted) connectionScope = new AbortController();
        void connect();
      } else {
        generation++; connectionScope.abort(); cancelRetry(); retryUntil = 0;
        failed(new Error('调试连接暂时断开，正在有限恢复，不重放业务动作'));
      }
    }));
    started = new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); release();
        startedReady = null;
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('调试启动等待已撤销'));
      let release = () => {};
      const timer = setTimeout(() => finish(new Error('调试连接尚未就绪，普通业务仍可继续')), 5000);
      startedReady = () => { if (state === 'connected') finish(); };
      release = channel.subscribe(next => {
        if (next.state === 'ready') void connect().then(() => {
          if (state === 'connected') finish();
        });
      });
      if (done) release();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return started;
  }
  function dispose(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      generation++;
      cancelRetry(); connectionScope.abort(); lifetime.abort();
      for (const release of releases.splice(0)) release();
      if (instanceId && channel.connected())
        await channel.request('bridge:close', { instance_id: instanceId }, AbortSignal.timeout(2000), 2000).catch(() => {});
      state = 'closed'; activeSessions = 0;
      try { options.select([]); } catch { /* 父作用域可先结束。 */ }
      channel.release(); receipts.clear();
      await bounded(Promise.allSettled([...inflight.values()].map(entry => entry.work)), AbortSignal.timeout(2000)).catch(() => {});
      options.signal.removeEventListener('abort', abort);
    })();
    return closing;
  }
  const abort = () => { void dispose(); };
  options.signal.addEventListener('abort', abort, { once: true });
  return { start, dispose, directoryChanged,
    snapshot: (): DebuggerBridgeSnapshot => ({ instanceId, state, activeSessions,
      inflight: inflight.size, unconfirmedReceipts, reason }) };
}
