import { ApiError } from '../../../services/api/index.ts';
import type { ApiClient } from '../../../services/api/index.ts';
import { createHttpJobGateway, createJobRunner, JobFailure, JobWaitFailure } from '../../../shared/jobs/index.ts';
import { createPluginDependenciesHttp } from '../services/http.ts';
import type {
  DependencyIssue, DependencyTarget, PluginDependenciesOptions, PluginDependenciesState,
} from '../types/index.ts';
import { canInstallDependency, initialPluginDependenciesState, missingRequiredDependencies } from '../utils/rules.ts';

function issue(error: unknown): DependencyIssue {
  return {
    message: error instanceof Error ? error.message : '插件依赖操作失败',
    logId: error instanceof ApiError ? error.logId : error instanceof JobFailure ? error.logId ?? error.submitLogId :
      error instanceof JobWaitFailure ? error.logId ?? error.lastKnownLogId ?? error.submitLogId : null,
  };
}

export function createPluginDependencies(
  client: ApiClient, target: DependencyTarget, options: PluginDependenciesOptions = {},
) {
  const waitTimeoutMs = options.waitTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 600000)
    throw new Error('依赖等待期限必须为 1 至 600000 毫秒');
  const http = createPluginDependenciesHttp(client);
  const listeners = new Set<() => void>();
  let state = initialPluginDependenciesState();
  let disposed = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let eventSequence = 0;
  const runner = createJobRunner({
    ...createHttpJobGateway(client),
    async getJob(id, signal) {
      const result = await http.getJob(id, signal);
      if (!disposed && !signal.aborted && state.ticket?.id === result.data.id &&
        state.ticket.operation === result.data.operation) {
        update({ job: result.data, logId: result.logId });
        try {
          const events = await http.getEvents(id, eventSequence, signal);
          if (disposed || signal.aborted || state.ticket?.id !== id) return result;
          for (const event of events.data) {
            if (event.job_id !== id || !Number.isSafeInteger(event.sequence) || event.sequence <= eventSequence)
              throw new ApiError('protocol', 'invalid_dependency_event', '依赖任务事件身份或顺序无效', null, events.logId);
            eventSequence = event.sequence;
            if (event.progress) update({ progress: { ...event.progress } });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if (!disposed && state.ticket?.id === id) {
            update({ progress: null });
            const current = issue(error), previous = state.issues.at(-1);
            if (current.message !== previous?.message || current.logId !== previous?.logId) appendIssue(error);
          }
        }
      }
      return result;
    },
  }, options);

  function update(patch: Partial<PluginDependenciesState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function appendIssue(error: unknown): void {
    update({ issues: [...state.issues, issue(error)].slice(-20) });
  }
  async function read(signal: AbortSignal): Promise<void> {
    const result = await http.get(target, signal);
    if (!disposed && !signal.aborted) update({ result, stale: false, logId: result.logId });
  }
  async function run(
    phase: PluginDependenciesState['phase'], signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (disposed) throw new ApiError('cancelled', 'cancelled', '依赖面板已关闭');
    if (state.phase !== 'idle') throw new ApiError('protocol', 'dependency_busy', '当前插件的依赖操作尚未结束');
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '依赖等待已取消');
    const local = new AbortController();
    controller = local;
    const current = ++generation;
    const combined = AbortSignal.any([signal, local.signal, AbortSignal.timeout(waitTimeoutMs)]);
    update({ phase, notice: null });
    try {
      await work(combined);
    } catch (error) {
      if (!disposed && current === generation) {
        if (combined.aborted) update({ stale: true, notice:
          state.ticket ? '已停止等待，服务器任务可能仍在执行；请查询任务状态，不会自动重复提交。' :
            phase === 'loading' ? '依赖读取已停止，可重新读取。' : '提交结果尚未确认，请先读取当前依赖状态；不会自动重复提交。' });
        else appendIssue(error);
      }
      throw error;
    } finally {
      if (current === generation) {
        controller = null;
        update({ phase: 'idle' });
      }
    }
  }
  async function finish(signal: AbortSignal): Promise<void> {
    const ticket = state.ticket;
    if (!ticket) return;
    try {
      const outcome = await runner.resume(ticket, signal, () => undefined);
      if (!signal.aborted && !disposed) update({ job: outcome.job, ticket: null, notice: '任务已完成，正在重新读取依赖状态。' });
    } catch (error) {
      if (error instanceof JobFailure && !signal.aborted && !disposed) {
        update({ job: error.job, ticket: null });
        try { await read(signal); } catch (readError) {
          if (!signal.aborted) appendIssue(readError);
        }
      }
      throw error;
    }
    // 任务结果格式不属于本面板契约，终态后只以 GET 视图为准。
    await read(signal);
    if (!signal.aborted && !disposed) update({ notice: '任务已完成，已重新读取依赖状态。' });
  }
  async function submit(action: 'scan' | 'install', ids: readonly string[] | undefined, signal: AbortSignal) {
    return run(action === 'scan' ? 'scanning' : 'installing', signal, async (current) => {
      if (state.ticket) throw new ApiError('protocol', 'dependency_task_unconfirmed', '请先查询已提交的依赖任务');
      if (!state.result || state.stale) throw new ApiError('protocol', 'dependency_view_required', '请先读取当前依赖状态');
      const command = { target: state.result.data.target, expected_revision: state.result.data.revision,
        ...(ids === undefined ? {} : { dependency_ids: ids }) };
      eventSequence = 0;
      update({ stale: true, job: null, progress: null });
      try {
        const submitted = await http[action](command, current);
        if (current.aborted || disposed) return;
        update({ job: submitted.data, logId: submitted.logId, ticket: {
          id: submitted.data.id, operation: submitted.data.operation, submitLogId: submitted.logId,
        } });
      } catch (error) {
        if (!current.aborted && error instanceof ApiError && error.kind === 'http') {
          try { await read(current); } catch (readError) { if (!current.aborted) appendIssue(readError); }
        }
        throw error;
      }
      await finish(current);
    });
  }

  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: (signal: AbortSignal) => run('loading', signal, read),
    scan: (signal: AbortSignal) => submit('scan', undefined, signal),
    installRequired(signal: AbortSignal) {
      const ids = missingRequiredDependencies(state.result?.data.dependencies ?? []);
      if (!ids.length) return Promise.reject(new ApiError('protocol', 'dependency_nothing_to_install', '没有可安装的缺失必需依赖'));
      return submit('install', ids, signal);
    },
    installDependency(id: string, signal: AbortSignal) {
      const dependency = state.result?.data.dependencies.find((item) => item.id === id);
      if (!dependency || !canInstallDependency(dependency))
        return Promise.reject(new ApiError('protocol', 'dependency_not_installable', '当前依赖不能自动安装'));
      return submit('install', [id], signal);
    },
    query: (signal: AbortSignal) => run('querying', signal, finish),
    cancel() {
      if (!controller) return;
      ++generation;
      controller.abort();
      controller = null;
      update({ phase: 'idle', stale: true, notice: state.ticket ?
        '已停止等待，服务器任务可能仍在执行；请查询任务状态，不会自动重复提交。' :
        '已停止等待；取消客户端等待不代表服务器回滚，请先读取当前状态。' });
    },
    dispose() {
      disposed = true;
      ++generation;
      controller?.abort();
      controller = null;
      runner.dispose();
      listeners.clear();
    },
  };
}

export type PluginDependenciesController = ReturnType<typeof createPluginDependencies>;
