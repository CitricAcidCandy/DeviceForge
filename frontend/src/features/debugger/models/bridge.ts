import { ApiError } from '../../../services/api/index.ts';
import { isJsonData } from '../../../shared/jobs/index.ts';
import { HostError } from '../../../plugin-sdk/index.ts';
import type { BridgeCommand, DebuggerBridgeOptions, DebuggerBridgeSnapshot } from '../types/index.ts';
import { bounded, delay } from '../utils/wait.ts';

export function createDebuggerBridge(options: DebuggerBridgeOptions) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const heartbeatMs = options.heartbeatMs ?? 5000;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 10) throw new Error('调试心跳间隔必须至少为 10 毫秒');
  const seen = new Set<string>();
  const inflight = new Set<Promise<void>>();
  let state: DebuggerBridgeSnapshot['state'] = 'idle';
  let instanceId: string | null = null;
  let activeSessions = 0, unconfirmedReceipts = 0;
  let reason: string | null = null;
  let starting: Promise<void> | null = null, loop: Promise<void> | null = null, closing: Promise<void> | null = null;
  const budget = (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  const snapshot = (): DebuggerBridgeSnapshot => ({ instanceId, state, activeSessions,
    inflight: inflight.size, unconfirmedReceipts, reason });
  async function control<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
    const waiting = budget(milliseconds);
    const busy = '宿主状态正在更新，调试桥在原期限内退避；不会重放业务动作';
    for (let attempt = 0; ; attempt++) {
      waiting.throwIfAborted();
      try {
        const result = await bounded(work(waiting), waiting);
        if (reason === busy) reason = null;
        return result;
      } catch (error) {
        // 仅重试宿主明确未受理的控制请求；容量耗尽、网络未知、回执及业务执行不走这里。
        if (!(error instanceof ApiError) || error.code !== 'debugger_busy' || attempt >= 6 || waiting.aborted) throw error;
        reason = busy;
        await delay(Math.min(25 * 2 ** attempt, 250), waiting);
      }
    }
  }
  function clearSelection() {
    activeSessions = 0;
    try { options.select([]); }
    catch { /* 父观测域可能已先释放，关闭不能向业务抛出第二次错误。 */ }
  }

  function select(sessions: readonly { target: { plugin_id: string; generation?: string | null }; state: string }[]) {
    const active = sessions.filter((session) => session.state === 'active');
    activeSessions = active.length;
    // 会话独立持有，采集按目标合并；关闭一个会话不会清掉另一观察者的选择。
    const targets = new Map<string, { plugin_id: string; generation: string | null }>();
    const directory = options.directory();
    for (const session of active) {
      const target = { plugin_id: session.target.plugin_id, generation: session.target.generation ?? null };
      // 轮询在途时插件可能已卸载或换代；旧目录不应使整条桥断线，更不能自动选择新代。
      if (!directory.some(current => current.plugin_id === target.plugin_id &&
        (current.generation ?? null) === target.generation)) continue;
      const prior = targets.get(target.plugin_id);
      if (prior && prior.generation !== target.generation) throw new Error('同一插件的活动调试会话代次不一致，请重新选择当前目标');
      targets.set(target.plugin_id, target);
    }
    options.select([...targets.values()]);
  }

  async function execute(command: BridgeCommand) {
    if (signal.aborted || !instanceId || command.target.instance_id !== instanceId ||
      seen.has(command.command_id)) return;
    if (seen.size >= 4096) throw new Error('本实例调试命令历史已满，请刷新页面建立新实例');
    seen.add(command.command_id);
    const selectedInstance = instanceId;
    const timeout = Math.min(command.remaining_ms, command.tool === 'reload' ? 30000 : 10000);
    const commandSignal = budget(Math.max(1, timeout));
    let success = false;
    let response: unknown;
    try {
      if (timeout <= 0) throw new Error('命令在领取时已到期');
      response = await bounded(Promise.resolve().then(() => options.execute(command, commandSignal)), commandSignal);
      if (!isJsonData(response) || new TextEncoder().encode(JSON.stringify(response)).length > 1024 * 1024)
        throw new Error('调试结果不符合 JSON 与大小限制');
      success = true;
    } catch (error) {
      const controlled = error instanceof HostError && error.code.startsWith('debugger_') ? error : null;
      response = { error: { code: commandSignal.aborted ? 'debugger_result_unconfirmed' : controlled?.code ?? 'debugger_action_failed',
        message: commandSignal.aborted ? '等待已结束，不能据此认定业务动作没有发生；请先检查目标状态，不要自动重试'
          : controlled?.message ?? '调试动作未能完成，请检查目标、参数和当前能力；未自动重试' } };
    }
    if (signal.aborted || instanceId !== selectedInstance) { unconfirmedReceipts++; return; }
    try {
      // 回执失败只记录未知结果，不能重新执行原动作。
      await options.gateway.acknowledge({ instance_id: selectedInstance,
        command_id: command.command_id, plugin_id: command.target.plugin_id,
        generation: command.target.generation ?? null, success, response }, budget(5000));
    } catch {
      unconfirmedReceipts++;
      reason = '至少一项结果回执未被宿主确认，请核对命令状态；不会自动重新执行动作';
    }
  }

  async function run() {
    try {
      while (!signal.aborted && instanceId) {
        const heartbeat = await control(waiting => options.gateway.heartbeat({ instance_id: instanceId ?? '',
          plugins: [...options.directory()] }, waiting), 5000);
        select(heartbeat.data.active_sessions);
        // 新会话可能恰好在心跳后创建；空闲等待不能耗尽默认五秒读取预算，也不空转长轮询。
        if (!activeSessions) { await delay(Math.min(heartbeatMs, 1000), signal); continue; }
        if (inflight.size >= 4) {
          await bounded(Promise.race([...inflight]), signal);
          continue;
        }
        const response = await control(waiting => options.gateway.poll({ instance_id: instanceId ?? '', limit: 4 - inflight.size }, waiting), 10000);
        if (response.data.instance_id !== instanceId) throw new Error('调试回执属于另一浏览器实例');
        if (seen.size + response.data.commands.filter((command) => !seen.has(command.command_id)).length > 4096)
          throw new Error('本实例命令历史已满，请刷新页面建立新实例');
        select(response.data.active_sessions);
        for (const command of response.data.commands) {
          if (inflight.size >= 4) throw new Error('宿主返回的命令超过本实例并发上限');
          const work = execute(command);
          inflight.add(work);
          void work.catch(() => { reason = '调试命令无法确认，未自动重放'; }).finally(() => inflight.delete(work));
        }
        await delay(response.data.commands.length ? 10 : 250, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        state = 'disconnected';
        reason = error instanceof ApiError ? error.message
          : '浏览器调试连接已中断，请刷新或显式重新连接；在途动作结果需要重新核对，不会自动重放';
        clearSelection();
      }
    }
  }

  function start(): Promise<void> {
    if (state === 'connecting' && starting) return starting;
    if (state === 'connected') return Promise.resolve();
    if (signal.aborted || state === 'closed') return Promise.reject(new Error('浏览器调试桥已关闭'));
    if (state !== 'idle') return Promise.reject(new Error('调试桥已经连接或断开，请先关闭并重新创建实例'));
    state = 'connecting';
    starting = (async () => {
      try {
        const result = await control(waiting => options.gateway.register({ plugins: [...options.directory()] }, waiting), 5000);
        instanceId = result.data.instance_id;
        if (signal.aborted) { await options.gateway.disconnect(instanceId, AbortSignal.timeout(2000)).catch(() => undefined); return; }
        state = 'connected';
        loop = run();
      } catch (error) {
        state = signal.aborted ? 'closed' : 'disconnected';
        reason = error instanceof ApiError ? error.message : '无法登记浏览器调试实例；请检查本机服务连接';
        throw error;
      }
    })();
    return starting;
  }

  function dispose(): Promise<void> {
    if (closing) return closing;
    lifetime.abort(); state = 'closed'; clearSelection();
    closing = (async () => {
      if (instanceId) await options.gateway.disconnect(instanceId, AbortSignal.timeout(2000)).catch(() => undefined);
      if (loop) await bounded(loop, AbortSignal.timeout(2000)).catch(() => undefined);
      await bounded(Promise.allSettled([...inflight]), AbortSignal.timeout(2000)).catch(() => undefined);
      options.signal.removeEventListener('abort', abort);
    })();
    return closing;
  }
  const abort = () => { void dispose(); };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  return { start, snapshot, dispose };
}
